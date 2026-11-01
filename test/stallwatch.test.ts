import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { hotspots, inspectorProfiler, StallWatch, type CpuProfile, type DelayHistogram, type Profiler, type StallOptions } from "../src/server/stallwatch.ts";
import { World } from "../src/server/world.ts";

// Nothing here waits for time to pass or runs the real profiler: the clocks, the timers and the
// profiler are the test's, so a loaded machine cannot change what the test sees. (The one test
// that does use V8's profiler asserts nothing about timing.)

/** The loop's clock and the wall clock, which the test moves together. */
function clocks() {
  let perf = 1000;
  let wall = Date.parse("2026-11-01T15:40:00.000Z");
  return { now: () => perf, wall: () => wall, advance: (ms: number) => { perf += ms; wall += ms; } };
}

/** A profile in which, `fromMs` into the window, the loop spent `ms` in react > sampleGit > spawnSync. */
function profileOf(fromMs: number, ms: number): CpuProfile {
  const frame = (functionName: string) => ({ functionName, url: "file:///office/src/server/x.ts", lineNumber: 41 });
  return {
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2] },
      { id: 2, callFrame: frame("react"), children: [3] },
      { id: 3, callFrame: frame("sampleGit"), children: [4] },
      { id: 4, callFrame: frame("spawnSync") },
    ],
    samples: [4, 2],
    timeDeltas: [fromMs * 1000, ms * 1000],
  };
}

function fakeProfiler(options: { failStart?: boolean; failStop?: boolean } = {}) {
  const calls = { start: 0, stop: 0, close: 0 };
  let next: CpuProfile = profileOf(0, 0);
  const profiler: Profiler = {
    start: async () => { calls.start++; if (options.failStart) throw new Error("no inspector"); },
    stop: async () => { calls.stop++; if (options.failStop) throw new Error("not running"); return next; },
    close: () => void calls.close++,
  };
  return { profiler, calls, willReturn: (profile: CpuProfile) => void (next = profile) };
}

function fakeHistogram(): DelayHistogram & { set(count: number, maxMs: number, meanMs: number): void } {
  let state = { count: 0, max: 9.2e18, mean: NaN };
  return {
    enable: () => undefined, disable: () => undefined, reset: () => { state = { count: 0, max: 9.2e18, mean: NaN }; },
    get count() { return state.count; }, get max() { return state.max; }, get mean() { return state.mean; }, percentile: () => state.count ? state.max / 2 : 0,
    set: (count, maxMs, meanMs) => { state = { count, max: maxMs * 1e6, mean: meanMs * 1e6 }; },
  };
}

function watcher(t: TestContext, options: Partial<StallOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stallwatch-test-"));
  const clock = clocks();
  const lines: string[] = [];
  const stand = fakeProfiler();
  const histogram = fakeHistogram();
  const watch = new StallWatch({ dir: join(dir, "stalls"), manual: true, now: clock.now, wall: clock.wall, profiler: stand.profiler, histogram, log: (l) => void lines.push(l), ...options });
  t.after(() => { watch.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { watch, dir: join(dir, "stalls"), lines, clock, histogram, ...stand };
}

/** The loop answering on time for `ms`: a tick every 100 ms. */
function calm(watch: StallWatch, clock: { advance(ms: number): void }, ms: number) {
  for (let spent = 0; spent < ms; spent += 100) {
    clock.advance(100);
    watch.tick();
  }
}

const profiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"));

test("a block is listed with when it began and how long, and its window's profile names the stack that held the loop", async (t) => {
  const { watch, dir, lines, clock, willReturn } = watcher(t);
  await watch.start();
  clock.advance(100);
  watch.tick();
  assert.deepEqual(watch.state().blocks, [], "a calm tick is no block");
  clock.advance(2500);
  watch.tick();
  const [block] = watch.state().blocks;
  assert.equal(block!.ms, 2400, "the tick was due 100 ms after the last, and came 2500 ms after it");
  assert.equal(block!.at, "2026-11-01T15:40:00.200Z", "it began when the tick was due, not when it arrived");
  assert.equal(block!.profile, null, "the profile is kept when the window closes");
  willReturn(profileOf(200, 2400));
  await watch.roll();
  const [kept] = watch.state().blocks;
  assert.match(kept!.profile!, /^2026-11-01T15-40-00-200Z-2400ms\.cpuprofile$/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, kept!.profile!), "utf8")), profileOf(200, 2400));
  assert.deepEqual(kept!.hotspots, [{ fn: "spawnSync", via: "sampleGit < react", where: "file:///office/src/server/x.ts:42", ms: 2400 }]);
  assert.match(lines.join("\n"), /did not answer for 2400 ms from 2026-11-01T15:40:00\.200Z/);
});

test("a tick one millisecond under the threshold is no block, and at it is one", async (t) => {
  const { watch, clock } = watcher(t, { thresholdMs: 1000, tickMs: 100 });
  await watch.start();
  clock.advance(100 + 999);
  watch.tick();
  assert.equal(watch.state().blocks.length, 0);
  clock.advance(100 + 1000);
  watch.tick();
  assert.deepEqual(watch.state().blocks.map((b) => b.ms), [1000]);
});

test("a calm window writes no profile, lists no block, and records its loop delay", async (t) => {
  const { watch, dir, clock, histogram, calls } = watcher(t);
  await watch.start();
  histogram.set(3000, 12.34, 0.5);
  calm(watch, clock, 30_000);
  await watch.roll();
  assert.deepEqual(watch.state().blocks, []);
  assert.deepEqual(profiles(dir), []);
  assert.equal(calls.stop, 1);
  assert.equal(calls.start, 2, "the next window is already being profiled");
  assert.deepEqual(watch.state().windows.map(({ maxMs, meanMs }) => ({ maxMs, meanMs })), [{ maxMs: 12.3, meanMs: 0.5 }]);
  calm(watch, clock, 30_000);
  await watch.roll();
  assert.deepEqual(watch.state().windows[0], { at: "2026-11-01T15:40:30.000Z", maxMs: 0, p99Ms: 0, meanMs: 0 }, "no samples is no delay, not an enormous one");
});

test("only the newest profiles are kept, and an older block says its profile is gone", async (t) => {
  const { watch, dir, clock, willReturn } = watcher(t, { keep: 2 });
  await watch.start();
  for (const ms of [1500, 2500, 3500]) {
    clock.advance(100 + ms);
    watch.tick();
    willReturn(profileOf(0, ms));
    await watch.roll();
  }
  assert.equal(profiles(dir).length, 2);
  const blocks = watch.state().blocks;
  assert.deepEqual(blocks.map((b) => b.ms), [3500, 2500, 1500]);
  assert.equal(blocks[2]!.profile, null);
  assert.ok(blocks[0]!.profile && blocks[1]!.profile);
  assert.ok(existsSync(join(dir, blocks[0]!.profile!)));
});

test("a restart still lists the blocks of the last run, minus profiles that are gone", async (t) => {
  const first = watcher(t);
  await first.watch.start();
  first.clock.advance(2000);
  first.watch.tick();
  first.willReturn(profileOf(100, 1900));
  await first.watch.roll();
  const kept = first.watch.state().blocks[0]!.profile!;
  first.watch.stop();
  const again = new StallWatch({ dir: first.dir, manual: true, now: first.clock.now, wall: first.clock.wall, profiler: fakeProfiler().profiler, histogram: fakeHistogram(), log: () => {} });
  t.after(() => again.stop());
  await again.start();
  assert.deepEqual(again.state().blocks.map((b) => b.profile), [kept]);
  rmSync(join(first.dir, kept));
  const later = new StallWatch({ dir: first.dir, manual: true, profiler: fakeProfiler().profiler, histogram: fakeHistogram(), log: () => {} });
  t.after(() => later.stop());
  await later.start();
  assert.deepEqual(later.state().blocks.map((b) => b.profile), [null]);
});

test("blocks are still listed when the profiler cannot start or stop", async (t) => {
  const noStart = watcher(t, { profiler: fakeProfiler({ failStart: true }).profiler });
  await noStart.watch.start();
  assert.equal(noStart.watch.state().profiling, false);
  assert.match(noStart.lines.join("\n"), /no CPU profile \(no inspector\)/);
  noStart.clock.advance(2000);
  noStart.watch.tick();
  await noStart.watch.roll();
  assert.equal(noStart.watch.state().blocks.length, 1);
  assert.equal(noStart.watch.state().blocks[0]!.profile, null);
  assert.deepEqual(profiles(noStart.dir), []);

  const noStop = watcher(t, { profiler: fakeProfiler({ failStop: true }).profiler });
  await noStop.watch.start();
  noStop.clock.advance(2000);
  noStop.watch.tick();
  await noStop.watch.roll();
  assert.equal(noStop.watch.state().blocks.length, 1);
  assert.equal(noStop.watch.state().blocks[0]!.profile, null);
  assert.match(noStop.lines.join("\n"), /profile stop failed: not running/);
});

test("hotspots counts only the samples in the block, longest stack first, and ignores idle time", () => {
  const frame = (functionName: string) => ({ functionName, url: "", lineNumber: 0 });
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2, 3, 4] },
      { id: 2, callFrame: frame("(idle)") },
      { id: 3, callFrame: frame("short") },
      { id: 4, callFrame: frame("long") },
    ],
    samples: [3, 2, 3, 4, 3],
    timeDeltas: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
  };
  // The samples sit at 1, 2, 3, 4 and 5 s; the block is 2.5 s to 4.5 s.
  const found = hotspots(profile, 2_500_000, 4_500_000);
  assert.deepEqual(found.map((h) => [h.fn, h.ms, h.where]), [["short", 1000, "(native)"], ["long", 1000, "(native)"]]);
});

test("V8's own profiler yields a profile the watch can keep", async (t) => {
  const { watch, dir, clock } = watcher(t, { profiler: inspectorProfiler() });
  await watch.start();
  assert.equal(watch.state().profiling, true);
  clock.advance(2000);
  watch.tick();
  await watch.roll();
  assert.equal(watch.state().profiling, true, "the next window is profiled");
  const [block] = watch.state().blocks;
  const profile = JSON.parse(readFileSync(join(dir, block!.profile!), "utf8")) as CpuProfile;
  assert.ok(profile.nodes.length > 0);
});

test("GET /api/machine/stalls lists the blocks, and is 404 when the watch is off", async (t) => {
  const { watch, clock } = watcher(t);
  await watch.start();
  clock.advance(2000);
  watch.tick();
  const db = openDatabase(":memory:");
  const files = mkdtempSync(join(tmpdir(), "stallwatch-files-"));
  const inbox = new Inbox(db, files, { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = new World(db, null, () => inbox.state());
  const on = createInboxServer(inbox, null, { port: 49998, staticDir: null, world, stalls: watch });
  const off = createInboxServer(inbox, null, { port: 49998, staticDir: null, world });
  t.after(() => { on.close(); off.close(); db.close(); rmSync(files, { recursive: true, force: true }); });
  const get = async (server: ReturnType<typeof createInboxServer>) => {
    const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "GET", url: "/api/machine/stalls", headers: { host: "localhost:49998" } }) as unknown as IncomingMessage;
    let status = 0;
    let body = "";
    let done!: () => void;
    const ended = new Promise<void>((resolve) => { done = resolve; });
    const res = { setHeader: () => {}, writeHead: (code: number) => { status = code; }, write: () => {}, end: (s: string) => { body = s; done(); } } as unknown as ServerResponse;
    server.emit("request", req, res);
    await ended;
    return { status, body: JSON.parse(body) as { blocks?: Array<{ ms: number }> } };
  };
  const listed = await get(on);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.blocks![0]!.ms, 1900);
  assert.equal((await get(off)).status, 404);
});
