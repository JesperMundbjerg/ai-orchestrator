// Optional browser check of the office gym (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/gym.browser.mjs
// Starts its own isolated office through the scratch launcher (test/gym-office.fixture.ts: a fake world of idle agents,
// herdr disabled, nothing read from sessions or accounts), on a free port that is never 4870, in headless Chromium,
// and closes both in finally. Four idle agents train, one a station, and move round the stations together each visit;
// the clock is held inside a visit at each lift's phases (stepping on a visit for those a lifter's routine there doesn't
// reach) to check the hands are on the bar and everyone has moved on, with pictures at desktop and phone width, a short
// video of each and one across a visit's end. Then everyone gets work: the lifters leave and the bars go back.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";
import { gymCorner, gymSpot, PLATE_R, PLATFORM_H, PULL_Y, PULL_Z, routine, STATIONS, VISIT, visitAt } from "../src/ui/world/gym.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-gym-test-"));
const shots = process.env.SHOTS ?? join(homedir(), ".review-inbox/handoffs/agent-office/gym");
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

// What each lift looks like, as seconds into a set of it; each lifter's routine (seeded by their id) says when that is.
const PHASES = [
  { station: "platform", lift: "snatch", name: "snatch-1-setup", at: 1.3 },
  { station: "platform", lift: "snatch", name: "snatch-2-pull", at: 2.1 },
  { station: "platform", lift: "snatch", name: "snatch-3-catch", at: 2.7 },
  { station: "platform", lift: "snatch", name: "snatch-4-overhead", at: 4.3 },
  { station: "platform", lift: "snatch", name: "snatch-5-drop", at: 5.0 },
  { station: "platform", lift: "clean", name: "clean-1-setup", at: 1.3 },
  { station: "platform", lift: "clean", name: "clean-2-front-squat", at: 2.7 },
  { station: "platform", lift: "clean", name: "clean-3-shoulders", at: 4.4 },
  { station: "platform", lift: "clean", name: "clean-4-dip", at: 5.0 },
  { station: "platform", lift: "clean", name: "clean-5-jerk", at: 6.4 },
  { station: "rack", lift: "squat", name: "squat-1-unrack", at: 1.2 },
  { station: "rack", lift: "squat", name: "squat-2-standing", at: 2.4 },
  { station: "rack", lift: "squat", name: "squat-3-bottom", at: 3.8 },
  { station: "rack", lift: "frontsquat", name: "frontsquat-1-unrack", at: 1.6 },
  { station: "rack", lift: "frontsquat", name: "frontsquat-2-standing", at: 3.0 },
  { station: "rack", lift: "frontsquat", name: "frontsquat-3-bottom", at: 4.4 },
  { station: "bench", lift: "bench", name: "bench-1-lockout", at: 2.2 },
  { station: "bench", lift: "bench", name: "bench-2-chest", at: 3.6 },
  { station: "pullup", lift: "pullup", name: "pullup-1-hang", at: 1.6 },
  { station: "pullup", lift: "pullup", name: "pullup-2-top", at: 2.6 },
  { station: "pullup", lift: "kneeraise", name: "kneeraise-1-hang", at: 1.6 },
  { station: "pullup", lift: "kneeraise", name: "kneeraise-2-top", at: 2.8 },
  // The rests between sets: sat up on the bench, and the first rest at each of the others.
  { station: "bench", rest: true, name: "rest-bench-sit", at: 3 },
  { station: "platform", rest: true, name: "rest-platform", at: 3 },
  { station: "rack", rest: true, name: "rest-rack", at: 3 },
  { station: "pullup", rest: true, name: "rest-pullup", at: 3 },
];
/** When a phase comes, in ms on the office's clock, for this lifter: into the first set of its lift, or the first rest. */
const when = (p, t) => {
  const seg = routine(p.station, t.seed).find((g) => (p.rest ? !!g.rest : !g.rest && g.lift === p.lift));
  return t.start + (seg.at + p.at) * 1000;
};
/** Whether this lifter's routine gets to a phase before they move on (a set that wouldn't be over becomes a rest). */
const reaches = (p, t) => {
  const segs = routine(p.station, t.seed), seg = segs.find((g) => (p.rest ? !!g.rest : !g.rest && g.lift === p.lift));
  const budget = (t.until - t.start) / 1000;
  return !!seg && segs.every((g) => g.rest || g.at > seg.at || g.at + g.length <= budget) && seg.at + (p.rest ? p.at : seg.length) <= budget;
};
// Gripping the bar at these: the hands must be on it.
const GRIPPED = new Set(PHASES.filter((p) => !p.rest && !/drop/.test(p.name)).map((p) => p.name));

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
        let store, view, gym, plan;
        const avatars = new Map();
        const visit = (f) => {
          if (!f) return;
          const p = f.memoizedProps;
          if (p?.plan?.rooms) plan = p.plan;
          if (p?.value?.getState && p.value.getState()?.scene) store = p.value.getState();
          if (p?.value?.training instanceof Map && typeof p.value.seconds === "function") gym = p.value;
          if (p?.agent && p?.spot) avatars.set(p.agent.id, { id: p.agent.id, status: p.agent.status, spot: p.spot });
          let h = f.memoizedState;
          while (h && typeof h === "object") { const v = h.memoizedState?.current; if (v && typeof v.eye === "number" && typeof v.yaw === "number") view = v; h = h.next; }
          visit(f.child); visit(f.sibling);
        };
        for (const r of window.__roots) visit(r.current);
        return { store, view, gym, plan, avatars: [...avatars.values()] };
      };
    });
    await page.goto(`${url}/#/world`);
    await page.waitForFunction(() => !!window.__scene().store && !!window.__scene().view);
    return { context, page, errors };
  };
  /** Who trains at each station, and their clock, keyed by station. */
  const trainingNow = (page) => page.evaluate(() => {
    const s = window.__scene(), agents = new Set(s.avatars.filter((a) => a.spot.gym).map((a) => a.id));
    return Object.fromEntries([...s.gym.training].filter(([id]) => agents.has(id)).map(([id, t]) => [t.station, { ...t, id }]));
  });
  /** All four agent lifters at their stations and training there since `from` (regulars don't count). */
  const settledIn = (page, from, timeout) => page.waitForFunction((from) => {
    const s = window.__scene(), lifters = s.avatars.filter((a) => a.spot.gym);
    return lifters.length === 4 && lifters.every((a) => { const t = s.gym?.training.get(a.id); return t && t.station === a.spot.gym && t.start >= from; });
  }, from, { timeout });
  /**
   * Let the clock run to a visit (held, it would never reach the office's next look round), and wait until all four have
   * moved there and started; the clock is held within it from then on.
   */
  const holdVisit = async (page, v) => {
    await page.evaluate(() => { delete window.__now; });
    try { await settledIn(page, v * VISIT * 1000, 150_000); } catch (e) {
      const debug = await page.evaluate(() => { const s = window.__scene(); return { avatars: s.avatars.filter((a) => a.spot.gym).map((a) => [a.id, a.spot.gym]), training: [...s.gym.training].map(([id, t]) => [id, t.station, t.start, t.seed]), now: Date.now() }; });
      throw new Error(`visit ${v}: ${JSON.stringify(debug)}`, { cause: e });
    }
    return trainingNow(page);
  };
  /** Each phase once, a visit at a time; every lifter is at a new station each visit. */
  const shoot = async (page, phases, each) => {
    const left = [...phases];
    let v = visitAt(Date.now()), before = null;
    const rounds = [];
    while (left.length) {
      const at = await holdVisit(page, v);
      // Whichever visit they started in (the clock runs while they move round).
      v = visitAt(Math.min(...Object.values(at).map((t) => t.start)));
      const station = Object.fromEntries(Object.values(at).map((t) => [t.id, t.station]));
      assert.equal(Object.keys(station).length, 4, `four lifters at visit ${v}: ${JSON.stringify(at)}`);
      if (before) for (const [id, s] of Object.entries(station)) if (before[id]) assert.notEqual(s, before[id], `${id} moved on from ${s}`);
      rounds.push({ ...station, platform: at.platform && { seed: at.platform.seed, budget: (at.platform.until - at.platform.start) / 1000 } });
      for (const p of left.filter((p) => reaches(p, at[p.station]))) {
        await page.evaluate((t) => { window.__now = t; }, when(p, at[p.station]));
        await each(p, at[p.station]);
        left.splice(left.indexOf(p), 1);
      }
      before = station;
      v++;
      // Each phase needs its set to fit in what is left of a visit, so a few visits may pass before every one has come.
      assert.ok(!left.length || rounds.length < 10, `phases never reached: ${left.map((p) => p.name)} in ${JSON.stringify(rounds)}`);
    }
    return rounds;
  };
  const lifters = async (page) => page.evaluate(() => Object.fromEntries(window.__scene().avatars.filter((a) => a.spot.gym).map((a) => [a.spot.gym, a.id])));
  const look = async (page, station, { distance = 3.8, side = 3.0, pitch = -0.5, fov = 58 } = {}) => {
    const plan = await page.evaluate(() => { const p = window.__scene().plan; return { rooms: p.rooms, outline: p.outline, hall: p.hall }; });
    const spot = gymSpot(plan, station);
    const f = spot.facing, c = Math.cos(f), s = Math.sin(f);
    const target = [spot.pos[0] + s * -0.3, spot.pos[1] + c * -0.3];
    const eye = [target[0] + side * c + distance * s, target[1] - side * s + distance * c];
    // Close up, the founder's own bird in front of the camera would hide the lifter.
    await page.evaluate((v) => { const s = window.__scene(); Object.assign(s.view, v); s.store.scene.getObjectByName("founder-bird").visible = false; s.store.invalidate(); },
      { x: eye[0], z: eye[1], yaw: Math.atan2(target[0] - eye[0], eye[1] - target[1]), pitch, lift: 0.04, fov });
  };
  const overview = async (page, { distance = 7.5, fov = 62, pitch = -0.5 } = {}) => {
    const plan = await page.evaluate(() => { const p = window.__scene().plan; return { rooms: p.rooms, outline: p.outline, hall: p.hall }; });
    const c = gymCorner(plan);
    const target = c.at(0, -c.half + 1.2), eye = c.at(-1.2, -c.half + 1.2 + distance);
    await page.evaluate((v) => { const s = window.__scene(); Object.assign(s.view, v); s.store.scene.getObjectByName("founder-bird").visible = true; s.store.invalidate(); },
      { x: eye[0], z: eye[1], yaw: Math.atan2(target[0] - eye[0], eye[1] - target[1]), pitch, lift: 0.15, fov });
  };
  const settle = async (page, ms = 900) => { await page.waitForTimeout(ms); await page.evaluate(() => window.__scene().store.invalidate()); await page.waitForTimeout(150); };
  /** How far the hands are from the bar, across it: the bar's own axis is its local x. */
  const gap = async (page, station, lifter) => page.evaluate(({ station, lifter, pull }) => {
    const scene = window.__scene().store.scene;
    const avatar = scene.getObjectByName(`avatar:${lifter}`);
    const hands = avatar.getObjectsByProperty("name", "hand").map((h) => h.getWorldPosition(h.position.clone()));
    let bar, axis;
    if (station === "pullup") {
      const spot = window.__scene().avatars.find((a) => a.id === lifter).spot;
      bar = { x: spot.pos[0] + Math.sin(spot.facing) * pull.z, y: pull.y, z: spot.pos[1] + Math.cos(spot.facing) * pull.z };
      axis = { x: Math.cos(spot.facing), y: 0, z: -Math.sin(spot.facing) };
    } else {
      const g = scene.getObjectByName(`gym-bar:${station}`);
      bar = g.getWorldPosition(g.position.clone());
      axis = { x: Math.cos(g.rotation.y), y: 0, z: -Math.sin(g.rotation.y) };
    }
    return Math.max(...hands.map((h) => {
      const d = { x: h.x - bar.x, y: h.y - bar.y, z: h.z - bar.z };
      const along = d.x * axis.x + d.y * axis.y + d.z * axis.z;
      return Math.hypot(d.x - along * axis.x, d.y - along * axis.y, d.z - along * axis.z);
    }));
  }, { station, lifter, pull: { y: PULL_Y, z: PULL_Z } });

  const desk = await open({ width: 1600, height: 1000 });
  {
    const { page } = desk;
    await settledIn(page, 0, 60_000);
    const who = await lifters(page);
    assert.deepEqual(Object.keys(who).sort(), [...STATIONS].sort(), "one idle agent at each station");
    assert.equal(new Set(Object.values(who)).size, 4);
    const training = await trainingNow(page);
    await page.evaluate((t) => { window.__now = t; }, Math.max(...Object.values(training).map((t) => t.start)) + 2000);
    await overview(page);
    await settle(page, 1600);
    await page.screenshot({ path: join(shots, "desktop-gym-overview.png") });
    const gaps = {};
    let dropped = false;
    const rounds = await shoot(page, PHASES, async (p, t) => {
      await look(page, p.station, p.station === "bench" ? { side: 3.2, distance: 2.6, pitch: -0.42 } : {});
      await settle(page);
      await page.screenshot({ path: join(shots, `desktop-${p.name}.png`) });
      gaps[p.name] = await gap(page, p.station, t.id);
      if (GRIPPED.has(p.name)) assert.ok(gaps[p.name] < 0.06, `${p.name}: hands ${gaps[p.name].toFixed(3)} m from the bar (${JSON.stringify({ ...t, at: when(p, t) })})`);
      if (p.name === "snatch-5-drop") {
        // Just after the snatch set, its last single dropped: the bar lies where it was picked up, on the platform.
        const set = routine("platform", t.seed).find((g) => !g.rest && g.lift === "snatch");
        await page.evaluate((at) => { window.__now = at; }, t.start + (set.at + set.length + 1) * 1000);
        await settle(page, 400);
        const rest = await page.evaluate(() => window.__scene().store.scene.getObjectByName("gym-bar:platform").position.y);
        assert.ok(Math.abs(rest - (PLATE_R + PLATFORM_H)) < 0.002, `the platform bar rests on its plates (${rest})`);
        dropped = true;
      }
    });
    assert.ok(dropped);
    await writeFile(join(shots, "hand-gaps.json"), JSON.stringify({ gaps, rounds }, null, 2));
  }
  // At phone width: each lift once more, from further off.
  const phone = await open({ width: 390, height: 844 });
  {
    const { page } = phone;
    await settledIn(page, 0, 60_000);
    const training = await trainingNow(page);
    await page.evaluate((t) => { window.__now = t; }, Math.max(...Object.values(training).map((t) => t.start)) + 2000);
    await overview(page, { distance: 9, fov: 75, pitch: -0.55 });
    await settle(page, 1600);
    await page.screenshot({ path: join(shots, "phone-gym-overview.png") });
    await shoot(page, PHASES.filter((p) => /catch|overhead|front-squat|jerk|bottom|chest|top|sit/.test(p.name)), async (p) => {
      await look(page, p.station, p.station === "bench" ? { side: 3.4, distance: 3.4, pitch: -0.45, fov: 72 } : { distance: 5.4, side: 1.4, fov: 72 });
      await settle(page);
      await page.screenshot({ path: join(shots, `phone-${p.name}.png`) });
    });
  }
  // Videos in real time: the whole gym training, at each width.
  for (const [name, viewport, options] of [["desktop", { width: 1280, height: 800 }, {}], ["phone", { width: 390, height: 844 }, { distance: 9, fov: 75, pitch: -0.55 }]]) {
    const v = await open(viewport, true);
    await settledIn(v.page, 0, 60_000);
    await overview(v.page, options);
    await v.page.waitForTimeout(26_000);
    await v.context.close();
    await v.page.video().saveAs(join(shots, `${name}-gym.webm`));
    assert.deepEqual(v.errors, []);
  }
  // A video in real time across a visit's end: the four finish, walk along the lane to their next stations and start again.
  {
    const v = await open({ width: 1280, height: 800 }, true);
    await settledIn(v.page, 0, 60_000);
    // Closer than the overview, and without the founder's bird in front of the stations.
    await overview(v.page, { distance: 5.2, fov: 66, pitch: -0.62 });
    await v.page.evaluate(() => { const s = window.__scene(); s.store.scene.getObjectByName("founder-bird").visible = false; s.store.invalidate(); });
    // Long enough before the end to see them train, then until all four have started again.
    if ((visitAt(Date.now()) + 1) * VISIT * 1000 - Date.now() < 8000) {
      await v.page.waitForTimeout(9000);
      await settledIn(v.page, visitAt(Date.now()) * VISIT * 1000, 60_000);
    }
    const end = (visitAt(Date.now()) + 1) * VISIT * 1000;
    const first = await trainingNow(v.page);
    await v.page.waitForTimeout(Math.max(0, end - Date.now() - 8000));
    await settledIn(v.page, end, 60_000);
    await v.page.waitForTimeout(8000);
    const after = await trainingNow(v.page);
    await v.context.close();
    await v.page.video().saveAs(join(shots, "desktop-gym-moving-round.webm"));
    const was = Object.fromEntries(Object.values(first).map((t) => [t.id, t.station]));
    for (const t of Object.values(after)) if (was[t.id]) assert.notEqual(t.station, was[t.id], `${t.id} moved on`);
    assert.deepEqual(v.errors, []);
  }

  // Work arrives: the lifters walk back to their desks and the bars go back.
  {
    const { page } = desk;
    await page.evaluate(() => { delete window.__now; });
    const who = await lifters(page);
    await overview(page);
    await writeFile(control, "working");
    await page.waitForFunction(() => window.__scene().avatars.every((a) => a.status === "working" && !a.spot.gym), null, { timeout: 10_000 });
    await page.waitForFunction(() => window.__scene().gym.training.size === 0, null, { timeout: 10_000 });
    const bar = await page.evaluate(() => window.__scene().store.scene.getObjectByName("gym-bar:platform").position.y);
    assert.ok(Math.abs(bar - (PLATE_R + PLATFORM_H)) < 0.002, "the platform bar is back on the platform");
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(shots, "desktop-gym-leaving.png") });
    const away = await page.evaluate((ids) => ids.map((id) => window.__scene().store.scene.getObjectByName(`avatar:${id}`).position.toArray()), Object.values(who));
    const plan = await page.evaluate(() => { const p = window.__scene().plan; return { rooms: p.rooms, outline: p.outline, hall: p.hall }; });
    for (const [i, station] of Object.keys(who).entries()) {
      const spot = gymSpot(plan, station);
      assert.ok(Math.hypot(away[i][0] - spot.pos[0], away[i][2] - spot.pos[1]) > 1, `${station}'s lifter walked off`);
    }
  }
  assert.deepEqual(desk.errors, []);
  assert.deepEqual(phone.errors, []);
  console.log(`Gym checked in a scratch office on port ${port}: four stations, hands on the bar at every gripped phase, lifters move round together each visit, lifters leave on work. Screenshots and videos in ${shots}`);
} finally {
  await browser?.close();
  await office.stop();
  await rm(home, { recursive: true, force: true });
}
