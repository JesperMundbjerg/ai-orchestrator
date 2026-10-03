// Optional browser check of the Codex credits seedling (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/credits.browser.mjs
// Starts the real service through the scratch launcher with an isolated HOME whose only Codex data is a
// fixture rollout written here (no real sessions, no account call: all three opt-ins off, herdr disabled),
// on a free port that is never 4870, in headless Chromium, and closes both in finally. Three states:
// no credit data (unknown), credits left with the weekly limit reached, and none left.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";
import { seedlingSpot, SEEDLING_HEIGHT } from "../src/ui/world/meters.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-credits-test-"));
const shots = process.env.SHOTS ?? join(homedir(), ".review-inbox/handoffs/agent-office/credits");
await mkdir(shots, { recursive: true });
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://127.0.0.1:${port}`;

const now = new Date();
const day = join(home, ".codex/sessions", String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0"));
let n = 0;
/** A fresh rollout, newer than the last, as the codex CLI writes one (made-up numbers). */
async function rollout(credits, used) {
  await mkdir(day, { recursive: true });
  const at = new Date(Date.now() - 1000).toISOString();
  const limits = { limit_id: "codex", limit_name: null, primary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 2 * 86400 }, secondary: null, credits, plan_type: "pro", rate_limit_reached_type: null };
  const file = join(day, `rollout-${at.slice(0, 19).replace(/:/g, "-")}-01a0ee74-5a58-7122-907e-f27f0a72453${n++}.jsonl`);
  await writeFile(file, [{ timestamp: at, type: "session_meta", payload: { cwd: "/w/fixture" } }, { timestamp: at, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const office = await spawnScratchOffice(process.execPath, ["src/server/main.ts"], {
  env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
  stdio: "ignore",
});

let browser;
const evidence = [];
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i > 100) throw new Error("scratch office did not start");
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__roots = new Set();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_, root) => window.__roots.add(root), onCommitFiberUnmount: () => {} };
    window.__scene = () => {
      let store, view, seedling;
      const visit = (fiber) => {
        if (!fiber) return;
        const props = fiber.memoizedProps;
        if (props?.value?.getState && props.value.getState()?.scene) store = props.value.getState();
        if (props?.spot && props?.credits) seedling = { spot: props.spot, credits: props.credits };
        let hook = fiber.memoizedState;
        while (hook && typeof hook === "object") {
          const value = hook.memoizedState?.current;
          if (value && typeof value.eye === "number" && typeof value.yaw === "number" && typeof value.fov === "number") view = value;
          hook = hook.next;
        }
        visit(fiber.child); visit(fiber.sibling);
      };
      for (const root of window.__roots) visit(root.current);
      return { store, view, seedling };
    };
  });

  const states = [
    { name: "unknown", label: "Codex credits: unknown", write: null },
    { name: "credits-left", label: "Codex credits: 1,240 left · in use now", write: () => rollout({ has_credits: true, unlimited: false, balance: "1240.5000000000" }, 100) },
    { name: "none-left", label: "Codex credits: none left", write: () => rollout({ has_credits: false, unlimited: false, balance: "0" }, 100) },
  ];
  for (const s of states) {
    if (s.write) {
      await s.write();
      await delay(11_000); // the newest rollout is looked at again at most every 10 s
    }
    const api = (await (await fetch(`${url}/api/world`)).json()).usage.meters.find((m) => m.id === "codex.week").credits;
    await page.goto(`${url}/#/world`);
    await page.waitForFunction(() => window.__scene().view && window.__scene().seedling);
    const { spot, credits } = await page.evaluate(() => window.__scene().seedling);
    assert.deepEqual(credits, api, "the office draws what the service says");
    const [x, z] = seedlingSpot(spot);
    // Where the feeder check looks from (test/meters.browser.mjs), a little closer.
    await page.evaluate(({ spot }) => {
      const { store, view } = window.__scene();
      Object.assign(view, { x: spot.pos[0] + 1.2, z: spot.pos[1] + 2.2, yaw: -0.52, pitch: -0.62, lift: 0, fov: 50 });
      store.invalidate();
    }, { spot });
    await page.waitForTimeout(1500);
    const point = await page.evaluate(({ x, z, y }) => {
      const { store } = window.__scene();
      const p = store.camera.position.clone().set(x, y, z).project(store.camera);
      return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
    }, { x, z, y: SEEDLING_HEIGHT * 0.3 });
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(300);
    const tag = await page.evaluate(({ x, z }) => {
      const { store } = window.__scene();
      let shown = false;
      store.scene.traverse((o) => { if (o.isSprite && Math.abs(o.parent.position.x - x) < 1e-6 && Math.abs(o.parent.position.z - z) < 1e-6) shown = true; });
      return shown;
    }, { x, z });
    await page.screenshot({ path: join(shots, `credits-${s.name}.png`) });
    assert.ok(tag, `hovering the seedling shows its label (${s.name})`);
    const label = (await import("../src/ui/world/meters.ts")).creditLook(credits, Date.now()).label;
    assert.equal(label, s.label);
    evidence.push({ state: s.name, credits, label });
    await page.mouse.move(1400, 960);
  }
  assert.deepEqual(errors, []);
  await writeFile(join(shots, "checks.json"), JSON.stringify({ browser: await browser.version(), port, evidence, errors }, null, 2));
  console.log(`PASS: credits seedling unknown / left / none, hover labels. Scratch port ${port}; screenshots ${shots}`);
} finally {
  await browser?.close();
  await office.stop();
  await rm(home, { recursive: true, force: true });
}
