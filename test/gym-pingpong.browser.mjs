// Optional browser check of the office's ping pong table (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/gym-pingpong.browser.mjs
// Starts its own isolated office through the scratch launcher (test/gym-office.fixture.ts: a fake world of idle agents,
// herdr disabled, nothing read from sessions or accounts), on a free port that is never 4870, in headless Chromium,
// and closes both in finally. Two idle agents pair up at the table; the clock is held at the serve, its two bounces and
// the rally's hits and bounces, to check the ball meets each paddle, lands on the right side and clears the net, and
// at a point's end: the ball caught, held through the pause and tossed for the next serve. Pictures at desktop and
// phone width, a minute of video (several points, each kind of ending) and a short one at phone width. Then everyone gets work: the players leave and the ball rests.
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
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://127.0.0.1:${port}`;
const control = join(home, "control");
const office = await spawnScratchOffice(process.execPath, ["test/gym-office.fixture.ts"], {
  env: { ...process.env, GYM_AGENTS: "23", GYM_CONTROL: control, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
  stdio: "ignore",
});

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
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i === 100) throw new Error("Scratch office did not start");
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
  const open = async (viewport, video) => {
    const context = await browser.newContext({ viewport, ...(video ? { recordVideo: { dir: join(home, "video"), size: viewport } } : {}) });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__roots = new Set();
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
    await page.goto(`${url}/#/world`);
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
  // Work arrives: the players walk off, the rally stops and the ball rests on the table.
  {
    const { page } = desk;
    await page.evaluate(() => { delete window.__now; });
    await writeFile(control, "working");
    await page.waitForFunction(() => window.__scene().avatars.every((a) => a.status === "working" && a.spot.pingpong === undefined), null, { timeout: 10_000 });
    await page.waitForFunction(() => window.__scene().ping.playback.seconds(Date.now()) === null, null, { timeout: 10_000 });
    await page.waitForTimeout(2500);
    await look(desk.page, { distance: 6.5, side: 1.5, pitch: -0.45 });
    await settle(page, 300);
    await page.screenshot({ path: join(shots, "desktop-leaving.png") });
    const rest = await page.evaluate(() => window.__scene().store.scene.getObjectByName("pingpong-ball").position.y);
    assert.ok(Math.abs(rest - (TABLE_H + BALL_R)) < 0.002, "the ball rests on the table");
  }
  assert.deepEqual(desk.errors, []);
  assert.deepEqual(phone.errors, []);
  console.log(`Ping pong checked in a scratch office on port ${port}: two players paired, ball on each paddle at its hit, bounces on the right sides and over the net, held in hand between points, players leave on work. Screenshots and videos in ${shots}`);
} finally {
  await browser?.close();
  await office.stop();
  await rm(home, { recursive: true, force: true });
}
