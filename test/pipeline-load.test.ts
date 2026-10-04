import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { claimReload, classifyLoadFailure, describeLoadFailure, importWithRecovery, rememberReopen, takeReopen, type GuardStorage, type LoadEnvironment } from "../src/ui/pipelines/load.ts";

const memory = (): GuardStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
};
const environment = (storage: GuardStorage | null, clock = { now: 1_000_000 }) => {
  const reloads: number[] = [];
  const env: LoadEnvironment = { storage, now: () => clock.now, reload: () => { reloads.push(clock.now); } };
  return { env, reloads, clock };
};
const staleChunk = () => new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:4870/assets/PipelineEditor-OLD.js");

test("engine-specific chunk fetch failures are told apart from render crashes", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: http://x/assets/PipelineEditor-OLD.js", // Chrome, also a text/html answer for a missing asset
    "error loading dynamically imported module", // Firefox
    "Importing a module script failed.", // Safari
    "Unable to preload CSS for /assets/PipelineEditor-OLD.css", // Vite
  ]) assert.equal(classifyLoadFailure(new TypeError(message)), "stale-chunk", message);
  const named = new Error("boom"); named.name = "ChunkLoadError";
  assert.equal(classifyLoadFailure(named), "stale-chunk");
  assert.equal(classifyLoadFailure(new TypeError("Cannot read properties of null (reading 'repoRoot')")), "render");
  assert.equal(classifyLoadFailure("plain string"), "render");
});

test("the notice names the failure and only offers a reload for a stale page", () => {
  const stale = describeLoadFailure(staleChunk());
  assert.equal(stale.kind, "stale-chunk"); assert.equal(stale.canReload, true);
  assert.match(stale.message, /older than the office build/); assert.match(stale.detail, /PipelineEditor-OLD\.js/);
  const crash = describeLoadFailure(new TypeError("x is not iterable"));
  assert.equal(crash.kind, "render"); assert.equal(crash.canReload, false);
  assert.match(crash.message, /crashed while rendering/); assert.equal(crash.detail, "x is not iterable");
});

test("a stale chunk reloads the page once and keeps the loading state meanwhile", async () => {
  mock.method(console, "warn", () => {});
  try {
    const { env, reloads } = environment(memory());
    let settled = false;
    const result = importWithRecovery(() => Promise.reject(staleChunk()), env).then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(reloads, [1_000_000]);
    assert.equal(settled, false, "stays pending so Suspense keeps showing the loading fallback");
    void result;
  } finally { mock.restoreAll(); }
});

test("a reload that did not help is not repeated: the failure surfaces instead of looping", async () => {
  mock.method(console, "warn", () => {});
  try {
    const storage = memory(); const clock = { now: 1_000_000 };
    const first = environment(storage, clock);
    void importWithRecovery(() => Promise.reject(staleChunk()), first.env);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(first.reloads.length, 1);
    // The reloaded page (same sessionStorage) fails again moments later.
    clock.now += 2_000;
    const second = environment(storage, clock);
    await assert.rejects(importWithRecovery(() => Promise.reject(staleChunk()), second.env), /dynamically imported module/);
    assert.equal(second.reloads.length, 0);
    // Much later the guard has expired, so a genuinely new stale tab may recover again.
    clock.now += 60_000;
    assert.equal(claimReload(storage, clock.now), true);
  } finally { mock.restoreAll(); }
});

test("a successful load clears the guard so the next rebuild can recover too", async () => {
  const storage = memory();
  assert.equal(claimReload(storage, 1_000_000), true);
  assert.equal(claimReload(storage, 1_000_100), false);
  const { env, reloads } = environment(storage, { now: 1_000_200 });
  assert.equal(await importWithRecovery(() => Promise.resolve("editor"), env), "editor");
  assert.equal(claimReload(storage, 1_000_300), true);
  assert.equal(reloads.length, 0);
});

test("render crashes and unavailable storage never trigger a reload", async () => {
  const crash = environment(memory());
  await assert.rejects(importWithRecovery(() => Promise.reject(new TypeError("x is not iterable")), crash.env), /not iterable/);
  assert.equal(crash.reloads.length, 0);
  const noStorage = environment(null);
  await assert.rejects(importWithRecovery(() => Promise.reject(staleChunk()), noStorage.env), /dynamically imported module/);
  const blocked: GuardStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  const throwing = environment(blocked);
  await assert.rejects(importWithRecovery(() => Promise.reject(staleChunk()), throwing.env), /dynamically imported module/);
  assert.equal(noStorage.reloads.length + throwing.reloads.length, 0);
});

test("the reloaded page reopens the editor for the team that asked, once, and not for anyone else", () => {
  const storage = memory();
  rememberReopen(storage, "team-a", 1_000_000);
  assert.equal(takeReopen(storage, "team-b", 1_000_500), false, "another team's button stays closed");
  assert.equal(takeReopen(storage, "team-a", 1_000_500), true);
  assert.equal(takeReopen(storage, "team-a", 1_000_600), false, "one-shot");
  rememberReopen(storage, "team-a", 1_000_000);
  assert.equal(takeReopen(storage, "team-a", 1_000_000 + 60_000), false, "a stale request from an old session is ignored");
  assert.equal(takeReopen(null, "team-a", 0), false);
});
