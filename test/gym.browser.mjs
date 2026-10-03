// Optional browser check of the office gym (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/gym.browser.mjs
// Starts its own isolated office through the scratch launcher (test/gym-office.fixture.ts: a fake world of idle agents,
// herdr disabled, nothing read from sessions or accounts), on a free port that is never 4870, in headless Chromium,
// and closes both in finally. Four idle agents train, one a station; the clock is held at each lift's phases to check
// the hands are on the bar and to take pictures at desktop and phone width; a short video of each. Then everyone gets
// work: the lifters leave and the bars go back where they rest.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";
import { gymCorner, gymSpot, LIFTS, PLATE_R, PLATFORM_H, PULL_Y, PULL_Z, STATIONS } from "../src/ui/world/gym.ts";

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

// What each lift looks like, as seconds into its station's round.
const clean = LIFTS.snatch.length * 3;
const PHASES = [
  { station: "platform", name: "snatch-1-setup", at: 1.3 },
  { station: "platform", name: "snatch-2-pull", at: 2.1 },
  { station: "platform", name: "snatch-3-catch", at: 2.7 },
  { station: "platform", name: "snatch-4-overhead", at: 4.3 },
  { station: "platform", name: "snatch-5-drop", at: 5.0 },
  { station: "platform", name: "clean-1-setup", at: clean + 1.3 },
  { station: "platform", name: "clean-2-front-squat", at: clean + 2.7 },
  { station: "platform", name: "clean-3-shoulders", at: clean + 4.4 },
  { station: "platform", name: "clean-4-dip", at: clean + 5.0 },
  { station: "platform", name: "clean-5-jerk", at: clean + 6.4 },
  { station: "rack", name: "squat-1-unrack", at: 1.2 },
  { station: "rack", name: "squat-2-standing", at: 2.4 },
  { station: "rack", name: "squat-3-bottom", at: 3.8 },
  { station: "bench", name: "bench-1-lockout", at: 2.2 },
  { station: "bench", name: "bench-2-chest", at: 3.6 },
  { station: "pullup", name: "pullup-1-hang", at: 1.6 },
  { station: "pullup", name: "pullup-2-top", at: 2.6 },
];
// Gripping the bar at these: the hands must be on it.
const GRIPPED = new Set(PHASES.filter((p) => !/drop/.test(p.name)).map((p) => p.name));

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
          if (p?.value?.starts instanceof Map && typeof p.value.seconds === "function") gym = p.value;
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
    await page.waitForFunction(() => window.__scene().gym?.starts.size === 4, null, { timeout: 30_000 });
    const who = await lifters(page);
    assert.deepEqual(Object.keys(who).sort(), [...STATIONS].sort(), "one idle agent at each station");
    assert.equal(new Set(Object.values(who)).size, 4);
    const starts = await page.evaluate(() => Object.fromEntries(window.__scene().gym.starts));
    await page.evaluate((t) => { window.__now = t; }, Math.max(...Object.values(starts)) + 2000);
    await overview(page);
    await settle(page, 1600);
    await page.screenshot({ path: join(shots, "desktop-gym-overview.png") });
    const gaps = {};
    for (const p of PHASES) {
      const lifter = who[p.station];
      await page.evaluate((t) => { window.__now = t; }, starts[lifter] + p.at * 1000);
      await look(page, p.station, p.station === "bench" ? { side: 3.2, distance: 2.6, pitch: -0.42 } : {});
      await settle(page);
      await page.screenshot({ path: join(shots, `desktop-${p.name}.png`) });
      gaps[p.name] = await gap(page, p.station, lifter);
      if (GRIPPED.has(p.name)) assert.ok(gaps[p.name] < 0.06, `${p.name}: hands ${gaps[p.name].toFixed(3)} m from the bar`);
    }
    await writeFile(join(shots, "hand-gaps.json"), JSON.stringify(gaps, null, 2));
    // A dropped snatch lands where it was picked up, on the platform.
    const lifter = who.platform;
    await page.evaluate((t) => { window.__now = t; }, starts[lifter] + 7000);
    await settle(page, 400);
    const rest = await page.evaluate(() => window.__scene().store.scene.getObjectByName("gym-bar:platform").position.y);
    assert.ok(Math.abs(rest - (PLATE_R + PLATFORM_H)) < 0.002, `the platform bar rests on its plates (${rest})`);
  }
  // At phone width: each lift once more, from further off.
  const phone = await open({ width: 390, height: 844 });
  {
    const { page } = phone;
    await page.waitForFunction(() => window.__scene().gym?.starts.size === 4, null, { timeout: 30_000 });
    const who = await lifters(page);
    const starts = await page.evaluate(() => Object.fromEntries(window.__scene().gym.starts));
    await page.evaluate((t) => { window.__now = t; }, Math.max(...Object.values(starts)) + 2000);
    await overview(page, { distance: 9, fov: 75, pitch: -0.55 });
    await settle(page, 1600);
    await page.screenshot({ path: join(shots, "phone-gym-overview.png") });
    for (const p of PHASES.filter((p) => /catch|overhead|front-squat|jerk|bottom|chest|top/.test(p.name))) {
      await page.evaluate((t) => { window.__now = t; }, starts[who[p.station]] + p.at * 1000);
      await look(page, p.station, p.station === "bench" ? { side: 3.4, distance: 3.4, pitch: -0.45, fov: 72 } : { distance: 5.4, side: 1.4, fov: 72 });
      await settle(page);
      await page.screenshot({ path: join(shots, `phone-${p.name}.png`) });
    }
  }
  // Videos in real time: the whole gym training, at each width.
  for (const [name, viewport, options] of [["desktop", { width: 1280, height: 800 }, {}], ["phone", { width: 390, height: 844 }, { distance: 9, fov: 75, pitch: -0.55 }]]) {
    const v = await open(viewport, true);
    await v.page.waitForFunction(() => window.__scene().gym?.starts.size === 4, null, { timeout: 30_000 });
    await overview(v.page, options);
    await v.page.waitForTimeout(26_000);
    await v.context.close();
    await v.page.video().saveAs(join(shots, `${name}-gym.webm`));
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
    await page.waitForFunction(() => window.__scene().gym.starts.size === 0, null, { timeout: 10_000 });
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
  console.log(`Gym checked in a scratch office on port ${port}: four stations, hands on the bar at every gripped phase, lifters leave on work. Screenshots and videos in ${shots}`);
} finally {
  await browser?.close();
  await office.stop();
  await rm(home, { recursive: true, force: true });
}
