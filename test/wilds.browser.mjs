// Build first. Real Shift+W for 1 km; screenshots may use opt-in reproducible poses.
// Only a free-port scratch office/temp HOME; always headless, always closed in finally.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ground, WATER } from "../src/ui/world/wilds/land.ts";
import { planBuilding } from "../src/ui/world/building.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-wilds-"));
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const out = process.env.WILDS_OUTPUT ?? join(homedir(), ".review-inbox/handoffs/agent-office/wilds");
await mkdir(out, { recursive: true });
const office = spawn(process.execPath, ["src/server/main.ts"], {
  env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "", browser;
office.stdout.on("data", (d) => { logs += d; });
office.stderr.on("data", (d) => { logs += d; });
const percentile = (list, p) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))];
const summary = (list) => ({ median: percentile(list, 0.5), p95: percentile(list, 0.95), max: Math.max(...list) });
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i > 100) throw new Error(`Scratch office failed: ${logs}`);
    await delay(100);
  }
  const scratchWorld = await (await fetch(`${url}/api/world`)).json();
  assert.equal(scratchWorld.agents.length, 0, "scratch office must not see any live agents");
  browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem("review-inbox.office-layout", "building"));
  await page.goto(`${url}/?wildsMeasure=1#/world`);
  await page.waitForFunction(() => window.__wilds?.read().chunks === 81, null, { timeout: 30000 });
  const cdp = await page.context().newCDPSession(page);
  const read = () => page.evaluate(() => window.__wilds.read());
  const pose = async (p) => {
    await page.evaluate((detail) => dispatchEvent(new CustomEvent("wilds-measure-pose", { detail })), p);
    await page.waitForFunction(() => window.__wilds.read().pending === 0);
    await delay(1800);
  };
  const shot = async (name) => { const path = join(out, `${name}.png`); await page.screenshot({ path }); return path; };
  const screenshots = {};
  await page.getByRole("button", { name: "Front door ↗" }).click();
  await delay(2200);
  screenshots.wayOut = await shot("way-out");
  await page.keyboard.down("Shift"); await page.keyboard.down("w");
  await page.waitForFunction(() => window.__wilds.read().position[2] >= 60, null, { timeout: 30000 });
  // The benchmark begins outside the lawn. Never change pose or speed during these 1,000 m.
  const startZ = (await read()).position[2];
  const metrics = [];
  const measure = async (label) => {
    const frames = [];
    for (let i = 0; i < 20; i++) { frames.push(await read()); await delay(100); }
    const s = frames.at(-1);
    const raw = await cdp.send("Runtime.getHeapUsage");
    await cdp.send("HeapProfiler.collectGarbage");
    const gc = await cdp.send("Runtime.getHeapUsage");
    const m = { label, metres: s.position[2] - startZ, position: s.position, calls: summary(frames.map((f) => f.calls)), triangles: summary(frames.map((f) => f.triangles)), heapUsedBytes: raw.usedSize, heapAfterGCBytes: gc.usedSize, backingStorageBytes: gc.backingStorageSize, geometries: s.geometries, textures: s.textures, chunks: s.chunks, terrainSlots: s.terrainSlots, instanceBatches: s.instanceBatches, pending: s.pending, animals: s.animals.length, frameIntervalMs: summary(s.intervals.slice(-40)), frameWorkMs: summary(s.costs.slice(-40)) };
    metrics.push(m); console.log(JSON.stringify(m));
  };
  await measure("start");
  screenshots.near = await shot("near");
  await page.waitForFunction((target) => window.__wilds.read().position[2] >= target, startZ + 490, { timeout: 120000 });
  await measure("middle");
  await page.waitForFunction((target) => window.__wilds.read().position[2] >= target, startZ + 980, { timeout: 120000 });
  await measure("end");
  await page.keyboard.up("w"); await page.keyboard.up("Shift");
  const endZ = (await read()).position[2];
  assert.ok(endZ - startZ >= 995);
  assert.ok(metrics.every((m) => m.chunks <= 81 && m.animals <= 12));
  assert.ok(metrics.at(-1).heapAfterGCBytes < metrics[0].heapAfterGCBytes + 12_000_000, "retained heap must stay bounded");
  assert.ok(metrics.every((m) => m.terrainSlots === 81 && m.instanceBatches === 13), "GPU pool allocation must stay fixed");
  // Three uploads a slot only once it first enters the frustum; after warming up it plateaus.
  assert.equal(metrics.at(-1).geometries, metrics[1].geometries, "GPU uploads must plateau, not grow with distance");
  await delay(11000);
  const still = await read();
  const stillIntervalMs = summary(still.intervals.slice(-12));
  assert.ok(stillIntervalMs.median >= 180, "wildlife must not promote the still rate");
  await pose({ x: 0, z: endZ, yaw: Math.PI, pitch: -0.65, lift: 0.45 });
  screenshots.far = await shot("far");
  await pose({ x: 0, z: 34, yaw: Math.PI, pitch: -0.18 });
  screenshots.near = await shot("near");
  const bounds = planBuilding([], [], []).bounds;
  // Locate a genuine generated shore with water ahead, not an invented screenshot lake.
  let lake;
  for (let z = 60; z < 1000 && !lake; z += 2) for (let x = -60; x < 60; x += 2) {
    if (ground(x, z, bounds) > WATER + 0.25 && ground(x, z + 10, bounds) < WATER - 0.5) { lake = { x, z }; break; }
  }
  assert.ok(lake);
  await pose({ ...lake, yaw: Math.PI, pitch: -0.16 });
  screenshots.lake = await shot("lake");
  // Approach an actual nearby animal, with enough room that it doesn't flee before the shot.
  let animals = (await read()).animals;
  let animal = animals.find((a) => a.kind === "deer") ?? animals[0];
  if (!animal) { await pose({ x: 0, z: 200, yaw: 0 }); animals = (await read()).animals; animal = animals[0]; }
  assert.ok(animal);
  await pose({ x: animal.x, z: animal.z + 8, yaw: 0, pitch: -0.08 });
  screenshots.animals = await shot("animals");
  assert.deepEqual(errors, []);
  const result = { date: new Date().toISOString(), browser: await browser.version(), url, viewport: "1440x1000 DPR 1", renderer: "Chromium headless, ANGLE Metal", method: "Built production UI; empty scratch office, Building layout; real Shift+W at 9 m/s in a straight line. 20 snapshots per location, retained heap via CDP forced GC. Frame intervals include intentional 20fps pacing; frameWork is Wilds callback through after-render (CPU submission, not GPU time). Geometry uploads are lazy: fixed 81 terrain slots and 13 instance batches, first encountered slots upload during the first part of the walk, then plateau.", distanceMetres: endZ - startZ, metrics, stillIntervalMs, screenshots, errors };
  await writeFile(join(out, "measurements.json"), JSON.stringify(result, null, 2));
  await writeFile(join(out, "README.md"), `# Wilds — headless kilometre walk\n\n${result.method}\n\nDistance: ${result.distanceMetres.toFixed(1)} m. ${result.browser}, ${result.viewport}.\n\n| Location | Calls median / max | Triangles median | Retained JS heap MiB | Frame interval p50 / p95 ms | CPU frame p50 / p95 ms | Chunks / geometries |\n|---|---:|---:|---:|---:|---:|---:|\n${metrics.map((m) => `| ${m.label} (${m.metres.toFixed(0)} m) | ${m.calls.median} / ${m.calls.max} | ${m.triangles.median} | ${(m.heapAfterGCBytes / 1048576).toFixed(2)} | ${m.frameIntervalMs.median.toFixed(2)} / ${m.frameIntervalMs.p95.toFixed(2)} | ${m.frameWorkMs.median.toFixed(2)} / ${m.frameWorkMs.p95.toFixed(2)} | ${m.chunks} / ${m.geometries} |`).join("\n")}\n\nStill frame median: ${stillIntervalMs.median.toFixed(1)} ms. Full raw numbers in measurements.json. Screenshots: ${Object.values(screenshots).map((p) => p.split("/").at(-1)).join(", ")}.\n\nKnown first-version limits: walking crosses lakes at water level; no collision/navigation system added; animal models bob/hop/bank as whole instances, without skeletal animation. Far chunks retain the same 8×8 terrain grid to avoid LOD cracks, but have no vegetation. No reflective water, wind animation or external assets.\n`);
  console.log(`Evidence: ${out}`);
} finally {
  await browser?.close();
  if (office.exitCode === null) {
    office.kill("SIGTERM");
    await new Promise((r) => office.once("exit", r));
  }
  await rm(home, { recursive: true, force: true });
}
