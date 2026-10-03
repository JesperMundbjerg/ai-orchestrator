// Optional browser check of the office's regulars (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/regulars.browser.mjs
// Three isolated offices in turn, each through the scratch launcher (test/gym-office.fixture.ts: a fake world, herdr
// disabled, nothing read from sessions or accounts), on a free port that is never 4870, in headless Chromium, closed in
// finally. Nobody idle: two regulars play each other and the rest use the gym, moving round it each visit, with
// rests between sets (recorded across a visit's end). One idle agent: they play ping pong with a regular. Many idle
// agents: the agents take the stations and the table, the regulars step aside. Throughout, the regulars are never
// avatars, never counted in the header, and a click on one shows their card, never an agent's panel.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";
import { gymCorner } from "../src/ui/world/gym.ts";
import { pingCorner, TABLE_X, TABLE_Z } from "../src/ui/world/pingpong.ts";
import { CAST, VISIT } from "../src/ui/world/regulars.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const shots = process.env.SHOTS ?? join(homedir(), ".review-inbox/handoffs/agent-office/regulars");
await mkdir(shots, { recursive: true });

const freePort = async () => {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  assert.notEqual(port, 4870);
  return port;
};

/** One scratch office with `agents` agents, all working when `working`; `run` gets a page opener. */
async function withOffice(agents, working, run) {
  const home = await mkdtemp(join(tmpdir(), "inbox-regulars-test-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const control = join(home, "control");
  await writeFile(control, working ? "working" : "idle");
  const office = await spawnScratchOffice(process.execPath, ["test/gym-office.fixture.ts"], {
    env: { ...process.env, GYM_AGENTS: String(agents), GYM_CONTROL: control, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
    stdio: "ignore",
  });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try {
        const world = await (await fetch(`${url}/api/world`)).json();
        // Wait for the fixture to have put everyone to work, when asked.
        if (!working || world.agents.every((a) => a.status === "working")) break;
      } catch {}
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
        window.__scene = () => {
          let store, view, ping, plan, gym;
          const regulars = [];
          const avatars = new Map();
          const visit = (f) => {
            if (!f) return;
            const p = f.memoizedProps;
            if (p?.plan?.rooms) plan = p.plan;
            if (p?.placement?.regular) regulars.push(p.placement);
            if (p?.value?.training instanceof Map && typeof p.value.pose === "function") gym = p.value;
            if (p?.value?.getState && p.value.getState()?.scene) store = p.value.getState();
            if (p?.value?.playback && p.value.table) ping = p.value;
            if (p?.agent && p?.spot) avatars.set(p.agent.id, { id: p.agent.id, status: p.agent.status, spot: p.spot });
            let h = f.memoizedState;
            while (h && typeof h === "object") { const v = h.memoizedState?.current; if (v && typeof v.eye === "number" && typeof v.yaw === "number") view = v; h = h.next; }
            visit(f.child); visit(f.sibling);
          };
          for (const r of window.__roots) visit(r.current);
          const placed = regulars.map((p) => ({ id: p.regular.id, name: p.regular.name, act: p.act, gym: p.spot.gym ?? null, end: p.spot.pingpong ?? null, at: p.spot.pos }));
          // Who is training now, and whether they are resting between sets.
          const training = gym ? [...gym.training].map(([id, t]) => ({ id, station: t.station, rest: gym.pose(id, Date.now(), 1, {})?.rest ?? null })) : [];
          return { store, view, ping, plan, regulars: placed, training, avatars: [...avatars.values()] };
        };
      });
      await page.goto(`${url}/#/world`);
      await page.waitForFunction(() => !!window.__scene().store && !!window.__scene().view && window.__scene().regulars.length > 0);
      return { context, page, errors };
    };
    await run({ open, port });
  } finally {
    await browser?.close();
    await office.stop();
    await rm(home, { recursive: true, force: true });
  }
}

const planOf = (page) => page.evaluate(() => { const p = window.__scene().plan; return { rooms: p.rooms, outline: p.outline, hall: p.hall }; });
/** Look into a corner from in front of it, from above: the gym's stations, or the table and its lane. */
const look = async (page, where, { distance = 7.5, side = 0.4, pitch = -0.5, fov = 62 } = {}) => {
  const plan = await planOf(page);
  const { at, half } = where === "gym" ? gymCorner(plan) : pingCorner(plan);
  const x = where === "gym" ? 0.2 : TABLE_X, z = -half + (where === "gym" ? 1.9 : TABLE_Z + 0.6);
  const target = at(x, z), eye = at(x + side, z + distance);
  await page.evaluate((v) => { const s = window.__scene(); Object.assign(s.view, v); s.store.scene.getObjectByName("founder-bird").visible = false; s.store.invalidate(); },
    { x: eye[0], z: eye[1], yaw: Math.atan2(target[0] - eye[0], eye[1] - target[1]), pitch, lift: 0.04, fov });
  await page.waitForTimeout(900);
};
const rallying = (page) => page.waitForFunction(() => window.__scene().ping?.playback.seconds(Date.now()) !== null, null, { timeout: 40_000 });

/** What everyone can see that would make a regular an agent: avatars, the header's count, the agent panel. */
async function neverAgents(page, agents) {
  const s = await page.evaluate(() => ({ avatars: window.__scene().avatars.map((a) => a.id), count: document.querySelector(".world-top .muted")?.textContent ?? "" }));
  assert.ok(!s.avatars.some((id) => id.startsWith("regular:")), "no regular is an agent's avatar");
  assert.equal(s.avatars.length, agents);
  assert.match(s.count, new RegExp(`^${agents} agents?\\b`), `the header counts agents only: ${s.count}`);
  const listed = await page.evaluate((names) => names.filter((n) => [...document.querySelectorAll(".world-panel")].some((el) => el.textContent.includes(n))), CAST.map((r) => r.name));
  assert.deepEqual(listed, [], "no regular in the projects panel");
}

/** Click a regular: their card, and no agent's panel. */
async function clickRegular(page, name) {
  const at = await page.evaluate((name) => {
    const { store } = window.__scene();
    const o = store.scene.getObjectByName(`regular:${name}`);
    const v = o.getWorldPosition(o.position.clone());
    v.y += 1.1;
    v.project(store.camera);
    return { x: ((v.x + 1) / 2) * store.size.width, y: ((1 - v.y) / 2) * store.size.height };
  }, name);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  const card = await page.evaluate(() => document.querySelector('[aria-label$=", a regular"]')?.textContent ?? null);
  const panel = await page.evaluate(() => !!document.querySelector(".world-panel.agent"));
  return { card, panel };
}

const report = [];

// 1. Nobody idle: three agents at work, two regulars at the table and the rest in the gym.
await withOffice(3, true, async ({ open }) => {
  const desk = await open({ width: 1600, height: 1000 });
  const { page } = desk;
  const placed = await page.evaluate(() => window.__scene().regulars);
  const acts = placed.map((p) => p.act);
  assert.equal(acts.filter((a) => a === "play").length, 2, "two regulars play each other");
  assert.ok(acts.filter((a) => a === "lift").length >= 3, `the gym is busy: ${acts}`);
  assert.equal(new Set(placed.filter((p) => p.gym).map((p) => p.gym)).size, acts.filter((a) => a === "lift").length, "one to a station");
  await rallying(page);
  const pair = await page.evaluate(() => [...window.__scene().ping.playback.pair]);
  assert.ok(pair.every((id) => id.startsWith("regular:")), "two regulars at the table");
  await neverAgents(page, 3);
  await look(page, "gym");
  await page.screenshot({ path: join(shots, "1-nobody-idle-gym.png") });
  await look(page, "pingpong");
  await page.screenshot({ path: join(shots, "1-nobody-idle-table.png") });
  await look(page, "gym", { distance: 4.5, side: -1.8, pitch: -0.35 });
  const lifter = placed.find((p) => p.act === "lift").name;
  const click = await clickRegular(page, lifter);
  await page.screenshot({ path: join(shots, "1-click-regular.png") });
  assert.match(click.card ?? "", new RegExp(`${lifter} · Regular at the gym`));
  assert.equal(click.panel, false, "no agent panel for a regular");
  assert.deepEqual(desk.errors, []);
  // At phone width too.
  const phone = await open({ width: 390, height: 844 });
  await look(phone.page, "gym", { distance: 9, pitch: -0.55, fov: 80 });
  await phone.page.screenshot({ path: join(shots, "1-nobody-idle-gym-phone.png") });
  assert.deepEqual(phone.errors, []);
  report.push(`nobody idle: ${acts.filter((a) => a === "lift").length} regulars lifting, 2 playing each other`);
});

// 1b. Moving round: about a minute across a visit's end, in real time, with the regulars resting between sets and
// moving on to new stations. A screenshot on each side of the change, and of a rest.
await withOffice(3, true, async ({ open }) => {
  const visit = VISIT * 1000;
  // Start recording a quarter of a minute before the visit ends.
  const lead = 15_000;
  await delay(((visit - lead - 4000 - (Date.now() % visit)) + visit) % visit);
  const v = await open({ width: 1280, height: 800 }, true);
  const { page } = v;
  await look(page, "gym", { distance: 8.2, pitch: -0.48 });
  const before = await page.evaluate(() => window.__scene().regulars);
  const seen = { rests: new Set(), stations: new Map(before.filter((p) => p.gym).map((p) => [p.name, new Set([p.gym])])), aside: new Set() };
  let shotRest = false, shotBefore = false, shotAfter = false;
  const end = Date.now() + 62_000;
  while (Date.now() < end) {
    const s = await page.evaluate(() => ({ training: window.__scene().training, regulars: window.__scene().regulars }));
    for (const t of s.training) if (t.rest) seen.rests.add(`${t.id}:${t.rest}`);
    for (const p of s.regulars) {
      if (p.gym) (seen.stations.get(p.name) ?? seen.stations.set(p.name, new Set()).get(p.name)).add(p.gym);
      if (p.act !== "lift" && p.act !== "play") seen.aside.add(`${p.name}:${p.act}`);
    }
    const left = visit - (Date.now() % visit);
    if (!shotBefore && left < 3000) { await page.screenshot({ path: join(shots, "4-before-moving-round.png") }); shotBefore = true; }
    if (!shotAfter && shotBefore && left < visit - 12_000 && left > visit - 20_000) { await page.screenshot({ path: join(shots, "4-after-moving-round.png") }); shotAfter = true; }
    if (!shotRest && s.training.some((t) => t.rest === "sip" || t.rest === "shake" || t.rest === "breathe")) { await page.waitForTimeout(1200); await page.screenshot({ path: join(shots, "4-resting-between-sets.png") }); shotRest = true; }
    await page.waitForTimeout(250);
  }
  const after = await page.evaluate(() => window.__scene().regulars);
  await v.context.close();
  await v.page.video().saveAs(join(shots, "4-moving-round.webm"));
  assert.deepEqual(v.errors, []);
  const moved = before.filter((p) => p.gym).filter((p) => after.find((q) => q.name === p.name).gym !== p.gym);
  assert.ok(moved.length >= 3, `the gym's regulars moved on: ${moved.map((p) => p.name)}`);
  assert.ok(seen.rests.size >= 2, `rests between sets: ${[...seen.rests]}`);
  report.push(`moving round: ${moved.map((p) => `${p.name} ${p.gym}→${after.find((q) => q.name === p.name).act === "lift" ? after.find((q) => q.name === p.name).gym : after.find((q) => q.name === p.name).act}`).join(", ")}; rests seen ${[...seen.rests].map((r) => r.slice("regular:".length)).join(", ")}; aside ${[...seen.aside].join(", ") || "nobody"}`);
});

// 2. One idle agent: they play ping pong with a regular.
await withOffice(1, false, async ({ open }) => {
  const desk = await open({ width: 1600, height: 1000 });
  const { page } = desk;
  await rallying(page);
  const pair = await page.evaluate(() => [...window.__scene().ping.playback.pair]);
  assert.equal(pair.filter((id) => id.startsWith("regular:")).length, 1, "one regular");
  assert.ok(pair.includes("idle-0"), "and the one agent");
  const acts = Object.fromEntries((await page.evaluate(() => window.__scene().regulars)).map((r) => [r.name, r.act]));
  assert.equal(Object.values(acts).filter((a) => a === "watch").length, 1, "the other table regular watches");
  assert.equal(Object.values(acts).filter((a) => a === "play").length, 1, "one regular plays");
  await neverAgents(page, 1);
  await look(page, "pingpong");
  await page.screenshot({ path: join(shots, "2-one-idle-table.png") });
  assert.deepEqual(desk.errors, []);
  const v = await open({ width: 1280, height: 800 }, true);
  await rallying(v.page);
  await look(v.page, "pingpong");
  await v.page.waitForTimeout(12_000);
  await v.context.close();
  await v.page.video().saveAs(join(shots, "2-one-idle.webm"));
  assert.deepEqual(v.errors, []);
  report.push(`one idle agent: plays ${pair.find((id) => id.startsWith("regular:"))}`);
});

// 3. Many idle agents: they take every station and the table, the regulars step aside.
await withOffice(23, false, async ({ open }) => {
  const desk = await open({ width: 1600, height: 1000 });
  const { page } = desk;
  await page.waitForFunction(() => window.__scene().regulars.every((r) => r.act !== "lift" && r.act !== "play"));
  await rallying(page);
  const pair = await page.evaluate(() => [...window.__scene().ping.playback.pair]);
  assert.ok(pair.every((id) => !id.startsWith("regular:")), "two agents at the table");
  await neverAgents(page, 23);
  // Give everyone time to walk in and the regulars to step aside.
  await page.waitForTimeout(12_000);
  await look(page, "gym", { distance: 8.5 });
  await page.screenshot({ path: join(shots, "3-many-idle-gym.png") });
  await look(page, "pingpong", { distance: 8.5 });
  await page.screenshot({ path: join(shots, "3-many-idle-table.png") });
  assert.deepEqual(desk.errors, []);
  report.push("many idle agents: every regular aside (stretching, at the cooler, watching)");
});

console.log(`Regulars checked in three scratch offices: ${report.join("; ")}. Screenshots and videos in ${shots}`);
