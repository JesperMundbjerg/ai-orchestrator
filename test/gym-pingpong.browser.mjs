// Optional browser check of the office's ping pong table (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/gym-pingpong.browser.mjs
// Starts its own isolated office through the scratch launcher (test/gym-office.fixture.ts: a fake world of idle agents,
// herdr disabled, nothing read from sessions or accounts), on a free port that is never 4870, in headless Chromium,
// and closes both in finally. Two idle agents pair up at the table; the clock is held at the serve, its two bounces and
// the rally's hits and bounces, to check the ball meets each paddle, lands on the right side and clears the net, and
// at a point's end: the ball caught, held through the pause and tossed for the next serve. The world changing while they
// play (as a live office's does every few seconds) never restarts the rally. Pictures at desktop and
// phone width, a minute of video (several points, each kind of ending) and a short one at phone width. Then everyone gets work: the players leave and the ball rests.
// Last, in a second office, a lone agent playing a regular gets work mid-rally: the regular eases out of their swing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";
import { BALL_R, NET_H, pingCorner, pingSpot, RALLY, TABLE_H, TABLE_X, TABLE_Z } from "../src/ui/world/pingpong.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-pingpong-test-"));
const shots = process.env.SHOTS ?? join(homedir(), ".review-inbox/handoffs/agent-office/gym/pingpong");
await mkdir(shots, { recursive: true });
/** An isolated office of `agents` idle agents, in its own folder under the scratch HOME, on a free port that is never 4870. */
const startOffice = async (agents, name) => {
  const dir = join(home, name);
  await mkdir(dir);
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  assert.notEqual(port, 4870);
  const control = join(dir, "control");
  const office = await spawnScratchOffice(process.execPath, ["test/gym-office.fixture.ts"], {
    env: { ...process.env, GYM_AGENTS: agents, GYM_CONTROL: control, HOME: dir, INBOX_DATA_DIR: join(dir, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i === 100) { await office.stop(); throw new Error("Scratch office did not start"); }
    await delay(100);
  }
  return { port, url, control, stop: () => office.stop() };
};
let office, lone;

// The moments to hold: the serve, its bounces, a rally shot over the net and its bounce, and each hit's paddle; then
// the first point's end, the pause holding the ball, and the next toss; a long ball and a net ball.
const serve = RALLY.hits[0];
const after = (t) => RALLY.flights.filter((f) => f.t0 >= t - 1e-6);
const [first, second] = after(serve.at);
const shot = after(RALLY.hits[1].at)[0];
const end = RALLY.holds.find((h) => h.winner !== undefined && h.t0 > serve.at);
const next = RALLY.hits.find((h) => h.serve && h.at > end.t0);
const longBall = RALLY.points.find((p) => p.ending === "long"), netBall = RALLY.points.find((p) => p.ending === "net");
const caught = (p) => RALLY.holds.find((h) => h.t0 > p.t0 && h.winner !== undefined).t0;
const MOMENTS = [
  { name: "1-toss", at: serve.at - 0.25 },
  { name: "2-serve", at: serve.at },
  { name: "3-serve-first-bounce", at: first.t1 },
  { name: "4-serve-over-net", at: second.t0 + ((second.t1 - second.t0) * Math.abs(second.a0)) / Math.abs(second.a1 - second.a0) },
  { name: "5-serve-second-bounce", at: second.t1 },
  { name: "6-return", at: RALLY.hits[1].at },
  { name: "7-rally-over-net", at: shot.t0 + ((shot.t1 - shot.t0) * Math.abs(shot.a0)) / Math.abs(shot.a1 - shot.a0) },
  { name: "8-rally-bounce", at: shot.t1 },
  { name: "9-rally-hit", at: RALLY.hits[3].at },
  { name: "10-point-caught", at: end.t0 + 0.05 },
  { name: "11-pause", at: (end.t1 + next.at) / 2 },
  { name: "12-next-toss", at: next.at - 0.25 },
  { name: "13-long-caught", at: caught(longBall) + 0.05 },
  { name: "14-net-caught", at: caught(netBall) + 0.05 },
];

let browser;
try {
  office = await startOffice("23", "pair");
  const { port, url, control } = office;
  browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
  const open = async (viewport, video, at = url) => {
    const context = await browser.newContext({ viewport, ...(video ? { recordVideo: { dir: join(home, "video"), size: viewport } } : {}) });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__roots = new Set();
      // The office's change feed, so the check can say the world changed (as a live office's does every few seconds).
      const RealSource = window.EventSource;
      window.EventSource = class extends RealSource { constructor(...args) { super(...args); window.__changes = this; } };
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_, r) => window.__roots.add(r), onCommitFiberUnmount: () => {} };
      const realNow = Date.now;
      Date.now = () => window.__now ?? realNow();
      window.__scene = () => {
        let store, view, ping, plan;
        const avatars = new Map();
        const visit = (f) => {
          if (!f) return;
          const p = f.memoizedProps;
          if (p?.plan?.rooms) plan = p.plan;
          if (p?.value?.getState && p.value.getState()?.scene) store = p.value.getState();
          if (p?.value?.playback && p.value.table) ping = p.value;
          if (p?.agent && p?.spot) avatars.set(p.agent.id, { id: p.agent.id, status: p.agent.status, spot: p.spot });
          let h = f.memoizedState;
          while (h && typeof h === "object") { const v = h.memoizedState?.current; if (v && typeof v.eye === "number" && typeof v.yaw === "number") view = v; h = h.next; }
          visit(f.child); visit(f.sibling);
        };
        for (const r of window.__roots) visit(r.current);
        return { store, view, ping, plan, avatars: [...avatars.values()] };
      };
    });
    await page.goto(`${at}/#/world`);
    await page.waitForFunction(() => !!window.__scene().store && !!window.__scene().view);
    return { context, page, errors };
  };
  const planOf = (page) => page.evaluate(() => { const p = window.__scene().plan; return { rooms: p.rooms, outline: p.outline, hall: p.hall }; });
  /** Look at the table from in front, a little to one side, from above: the whole rally in view. */
  const look = async (page, { distance = 4.8, side = 1.2, pitch = -0.5, fov = 60 } = {}) => {
    const { at, half } = pingCorner(await planOf(page));
    const target = at(TABLE_X, -half + TABLE_Z), eye = at(TABLE_X + side, -half + TABLE_Z + distance);
    await page.evaluate((v) => { const s = window.__scene(); Object.assign(s.view, v); s.store.scene.getObjectByName("founder-bird").visible = false; s.store.invalidate(); },
      { x: eye[0], z: eye[1], yaw: Math.atan2(target[0] - eye[0], eye[1] - target[1]), pitch, lift: 0.04, fov });
  };
  const settle = async (page, ms = 900) => { await page.waitForTimeout(ms); await page.evaluate(() => window.__scene().store.invalidate()); await page.waitForTimeout(150); };
  const playing = (page) => page.waitForFunction(() => window.__scene().ping?.playback.seconds(Date.now()) !== null, null, { timeout: 40_000 });
  /** The ball and each paddle's blade, in the world. */
  const measure = (page, pair) => page.evaluate((pair) => {
    const scene = window.__scene().store.scene;
    const p = (o) => o.getWorldPosition(o.position.clone());
    const ball = p(scene.getObjectByName("pingpong-ball"));
    const blades = pair.map((id) => p(scene.getObjectByName(`avatar:${id}`).getObjectByName("paddle")));
    return { ball: ball.toArray(), blades: blades.map((b) => b.toArray()) };
  }, pair);

  const desk = await open({ width: 1600, height: 1000 });
  const results = {};
  let pair;
  {
    const { page } = desk;
    await playing(page);
    pair = await page.evaluate(() => [...window.__scene().ping.playback.pair]);
    assert.equal(pair.length, 2);
    const ends = await page.evaluate((pair) => pair.map((id) => window.__scene().avatars.find((a) => a.id === id).spot.pingpong), pair);
    assert.deepEqual(ends, [0, 1], "one player at each end");
    const plan = await planOf(page);
    const start = await page.evaluate(() => { const now = Date.now(); return now - window.__scene().ping.playback.seconds(now) * 1000; });
    await look(page);
    for (const m of MOMENTS) {
      await page.evaluate((t) => { window.__now = t; }, start + m.at * 1000);
      await settle(page);
      await page.screenshot({ path: join(shots, `desktop-${m.name}.png`) });
      results[m.name] = await measure(page, pair);
    }
    // Each hit: the ball on the hitter's blade (the blade is 7.5 cm across).
    const blade = (name, end) => { const r = results[name]; return Math.hypot(...r.ball.map((v, i) => v - r.blades[end][i])); };
    for (const [name, end] of [["2-serve", serve.end], ["6-return", RALLY.hits[1].end], ["9-rally-hit", RALLY.hits[3].end]]) {
      assert.ok(blade(name, end) < 0.06, `${name}: the ball is ${blade(name, end).toFixed(3)} m from the paddle`);
    }
    // Bounces on the table's top, the serve's first on the server's side and its second on the other; over the net above it.
    const tableSide = (name) => {
      const [x, , z] = results[name].ball;
      const [sx, sz] = pingSpot(plan, 0).pos;
      return Math.hypot(x - sx, z - sz) < 2.2 ? 0 : 1;
    };
    for (const name of ["3-serve-first-bounce", "5-serve-second-bounce", "8-rally-bounce"]) assert.ok(Math.abs(results[name].ball[1] - (TABLE_H + BALL_R)) < 0.005, `${name} on the table`);
    assert.equal(tableSide("3-serve-first-bounce"), serve.end, "the serve bounces first on the server's side");
    assert.equal(tableSide("5-serve-second-bounce"), 1 - serve.end, "then on the other side");
    for (const name of ["4-serve-over-net", "7-rally-over-net"]) assert.ok(results[name].ball[1] > TABLE_H + NET_H + BALL_R, `${name}: clear of the net`);
    // Between points the ball is off the table and still: in the catcher's hand, then the server's.
    for (const name of ["10-point-caught", "11-pause", "13-long-caught", "14-net-caught"]) {
      assert.ok(Math.abs(results[name].ball[1] - (TABLE_H + BALL_R)) > 0.008, `${name}: the ball is in a hand, not on the table`);
    }
    await writeFile(join(shots, "measurements.json"), JSON.stringify(results, null, 2));
    // The world changes while they play (a message, a status, a title): the office works its plan out again, and the
    // rally goes on where it was rather than starting over with the ball back on the table.
    await page.evaluate(() => { delete window.__now; });
    const clock = () => page.evaluate(() => { const p = window.__scene().ping; return { pair: [...p.playback.pair], seconds: p.playback.seconds(Date.now()) }; });
    let before = await clock();
    for (let i = 0; i < 3; i++) {
      const fetched = page.waitForResponse((r) => r.url().endsWith("/api/world"));
      await page.evaluate(() => window.__changes.dispatchEvent(new MessageEvent("changed", { data: JSON.stringify({ reason: "world" }) })));
      await fetched;
      await settle(page, 600);
      const after = await clock();
      assert.deepEqual(after.pair, pair);
      assert.ok(after.seconds !== null && after.seconds > before.seconds + 0.4, `a world update restarted the rally: ${before.seconds?.toFixed(2)}s, then ${after.seconds?.toFixed(2)}s`);
      before = after;
    }
  }
  // At phone width: the serve, a rally shot over the net and a hit.
  const phone = await open({ width: 390, height: 844 });
  {
    const { page } = phone;
    await playing(page);
    const start = await page.evaluate(() => { const now = Date.now(); return now - window.__scene().ping.playback.seconds(now) * 1000; });
    await look(page, { distance: 6.2, side: 0.6, pitch: -0.55, fov: 78 });
    for (const m of MOMENTS.filter((m) => /serve$|over-net|rally-hit/.test(m.name))) {
      await page.evaluate((t) => { window.__now = t; }, start + m.at * 1000);
      await settle(page);
      await page.screenshot({ path: join(shots, `phone-${m.name}.png`) });
    }
  }
  // Videos in real time from the players' arrival: a minute of points at desktop width, and the first at phone width.
  for (const [name, viewport, options, ms] of [["desktop", { width: 1280, height: 800 }, {}, 62_000], ["phone", { width: 390, height: 844 }, { distance: 6.2, side: 0.6, pitch: -0.55, fov: 78 }, 14_000]]) {
    const v = await open(viewport, true);
    await playing(v.page);
    // Wound back to the players' arrival, so it opens on the pick-up and the first serve.
    await v.page.evaluate(() => {
      const ping = window.__scene().ping, now = Date.now(), shift = ping.playback.seconds(now) * 1000, prev = Date.now;
      Date.now = () => prev() - shift;
    });
    await look(v.page, options);
    await v.page.waitForTimeout(ms);
    await v.context.close();
    await v.page.video().saveAs(join(shots, `${name}-pingpong.webm`));
    assert.deepEqual(v.errors, []);
  }
  // Work arrives: the players walk off, the rally stops and the ball rests on the table until the regulars, back from
  // watching, take the table again and start a rally of their own (seconds later, so the rest is checked while nobody plays).
  {
    const { page } = desk;
    await page.evaluate(() => { delete window.__now; });
    await writeFile(control, "working");
    await page.waitForFunction(() => window.__scene().avatars.every((a) => a.status === "working" && a.spot.pingpong === undefined), null, { timeout: 10_000 });
    await page.waitForFunction((rest) => {
      const s = window.__scene();
      return s.ping.playback.seconds(Date.now()) === null && Math.abs(s.store.scene.getObjectByName("pingpong-ball").position.y - rest) < 0.002;
    }, TABLE_H + BALL_R, { timeout: 10_000 });
    await look(desk.page, { distance: 6.5, side: 1.5, pitch: -0.45 });
    await settle(page, 300);
    await page.screenshot({ path: join(shots, "desktop-leaving.png") });
    await page.waitForFunction(() => window.__scene().ping.playback.seconds(Date.now()) !== null, null, { timeout: 30_000 });
    await settle(page, 3000);
    await page.screenshot({ path: join(shots, "desktop-regulars-back.png") });
  }
  // A partner walks off mid-rally: a lone agent plays a regular and gets work. The regular, staying at their end, eases
  // out of the swing they were in and into standing, rather than snapping to it. The clock is held mid-swing as the agent
  // leaves, so the one staying must still be in that swing once the rally has stopped, then run on a few frames at a time.
  lone = await startOffice("1", "lone");
  const solo = await open({ width: 1280, height: 800 }, false, lone.url);
  {
    const { page } = solo;
    await playing(page);
    const plan = await planOf(page);
    const start = await page.evaluate(() => { const now = Date.now(); return now - window.__scene().ping.playback.seconds(now) * 1000; });
    const staying = await page.evaluate(([x, z]) => {
      let best = null;
      window.__scene().store.scene.traverse((o) => { if (o.name.startsWith("regular:") && Math.hypot(o.position.x - x, o.position.z - z) < 0.8) best = o.name; });
      return best;
    }, pingSpot(plan, 1).pos);
    assert.ok(staying, "a regular plays the lone agent at the other end");
    await look(page, { distance: 4.2, side: 2.2, pitch: -0.4 });
    const swing = start + (RALLY.hits.find((h) => h.end === 1 && !h.serve).at + 0.12) * 1000;
    const paddle = () => page.evaluate((name) => { const o = window.__scene().store.scene.getObjectByName(name).getObjectByName("paddle"); return o.getWorldPosition(o.position.clone()).toArray(); }, staying);
    const frame = async (ms, shot) => {
      await page.evaluate((t) => { window.__now = t; window.__scene().store.invalidate(); }, swing + ms);
      await page.waitForTimeout(120);
      if (shot) await page.screenshot({ path: join(shots, `partner-leaves-${shot}.png`) });
      return page.evaluate(() => window.__scene().ping.playback.seconds(Date.now()) === null);
    };
    await frame(0);
    await settle(page, 300);
    await page.screenshot({ path: join(shots, "partner-leaves-0-mid-swing.png") });
    const mid = await paddle();
    await writeFile(lone.control, "working");
    await page.waitForFunction(() => window.__scene().ping.playback.seconds(Date.now()) === null, null, { timeout: 10_000 });
    await frame(0, "1-rally-stopped");
    const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const stopped = await paddle();
    assert.ok(gap(stopped, mid) < 0.03, `the one staying snapped out of their swing as their partner left: the paddle moved ${gap(stopped, mid).toFixed(3)} m at once`);
    // Then the clock runs on: their swing carries on and fades into standing within a fraction of a second, no jumps.
    const trail = [stopped];
    for (const [i, ms] of [100, 200, 300, 400, 500, 600, 800, 1000].entries()) {
      if (!(await frame(ms, `${i + 2}-${ms}ms`))) break; // the next player is already in and playing
      trail.push(await paddle());
    }
    assert.ok(trail.length >= 6, "the rally stayed stopped long enough to see them ease out");
    for (let i = 1; i < trail.length; i++) assert.ok(gap(trail[i], trail[i - 1]) < 0.2, `the paddle jumps ${gap(trail[i], trail[i - 1]).toFixed(3)} m easing out`);
    if (trail.length === 9) assert.ok(gap(trail[8], trail[7]) < 0.03, "standing once eased out");
    assert.ok(gap(trail.at(-1), mid) > 0.08, "they end up standing, not frozen mid-swing");
    assert.deepEqual(solo.errors, []);
  }
  assert.deepEqual(desk.errors, []);
  assert.deepEqual(phone.errors, []);
  console.log(`Ping pong checked in a scratch office on port ${port}: two players paired, ball on each paddle at its hit, bounces on the right sides and over the net, held in hand between points, a world update never restarts the rally, a partner leaving mid-rally leaves the other easing out of their swing, players leave on work, the ball rests until the regulars take the table back. Screenshots and videos in ${shots}`);
} finally {
  await browser?.close();
  await office?.stop();
  await lone?.stop();
  await rm(home, { recursive: true, force: true });
}
