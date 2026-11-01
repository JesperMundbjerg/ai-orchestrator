import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { StallWatch } from "../src/server/stallwatch.ts";
import { World } from "../src/server/world.ts";

/** The loop held by one piece of synchronous work, the way a blocking git call holds it. */
function blockLoopForTest(ms: number): void {
  const until = performance.now() + ms;
  let n = 0;
  while (performance.now() < until) n++;
  if (n < 0) throw new Error("unreachable");
}

function watcher(t: TestContext, options: Partial<ConstructorParameters<typeof StallWatch>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stallwatch-test-"));
  const lines: string[] = [];
  const watch = new StallWatch({ dir: join(dir, "stalls"), thresholdMs: 150, windowMs: 400, tickMs: 20, log: (l) => void lines.push(l), ...options });
  t.after(() => { watch.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { watch, dir: join(dir, "stalls"), lines };
}

async function until(fn: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await delay(25);
  }
}

test("a block of the loop is listed with the function that held it, and its window's profile is kept", async (t) => {
  const { watch, dir, lines } = watcher(t);
  await watch.start();
  await delay(100);
  blockLoopForTest(350);
  await until(() => watch.state().blocks[0]?.profile != null);
  const [block] = watch.state().blocks;
  assert.ok(block!.ms >= 250, `block of ${block!.ms} ms`);
  assert.ok(existsSync(join(dir, block!.profile!)));
  assert.match(block!.profile!, /\.cpuprofile$/);
  assert.ok(block!.hotspots.some((h) => h.fn === "blockLoopForTest"), JSON.stringify(block!.hotspots));
  assert.match(lines.join("\n"), /did not answer for \d+ ms/);
});

test("a calm window writes no profile and lists no block", async (t) => {
  const { watch, dir } = watcher(t, { thresholdMs: 5000 });
  await watch.start();
  await until(() => watch.state().windows.length >= 2);
  assert.deepEqual(watch.state().blocks, []);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".cpuprofile")), []);
  assert.ok(watch.state().windows[0]!.maxMs >= 0);
});

test("only the newest profiles are kept, and an older block says its profile is gone", async (t) => {
  const { watch, dir } = watcher(t, { keep: 2 });
  await watch.start();
  for (let i = 0; i < 3; i++) {
    const before = watch.state().blocks.length;
    blockLoopForTest(250);
    await until(() => watch.state().blocks.length > before && watch.state().blocks[0]!.profile != null);
    await delay(450);
  }
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".cpuprofile")).length, 2);
  const blocks = watch.state().blocks;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[2]!.profile, null);
  assert.ok(blocks[0]!.profile && blocks[1]!.profile);
});

test("a restart still lists the blocks of the last run", async (t) => {
  const first = watcher(t);
  await first.watch.start();
  blockLoopForTest(250);
  await until(() => first.watch.state().blocks[0]?.profile != null);
  first.watch.stop();
  const again = new StallWatch({ dir: first.dir, thresholdMs: 150, windowMs: 400, log: () => {} });
  t.after(() => again.stop());
  await again.start();
  assert.equal(again.state().blocks.length, 1);
  assert.ok(again.state().blocks[0]!.profile);
});

test("GET /api/machine/stalls lists the blocks, and is 404 when the watch is off", async (t) => {
  const { watch } = watcher(t);
  await watch.start();
  blockLoopForTest(250);
  await until(() => watch.state().blocks.length > 0);
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(tmpdir(), "stallwatch-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = new World(db, null, () => inbox.state());
  const on = createInboxServer(inbox, null, { port: 49998, staticDir: null, world, stalls: watch });
  const off = createInboxServer(inbox, null, { port: 49998, staticDir: null, world });
  t.after(() => { on.close(); off.close(); db.close(); });
  const get = async (server: ReturnType<typeof createInboxServer>) => {
    const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "GET", url: "/api/machine/stalls", headers: { host: "localhost:49998" } }) as unknown as IncomingMessage;
    let status = 0;
    let body = "";
    let done!: () => void;
    const ended = new Promise<void>((resolve) => { done = resolve; });
    const res = { setHeader: () => {}, writeHead: (code: number) => { status = code; }, write: () => {}, end: (s: string) => { body = s; done(); } } as unknown as ServerResponse;
    server.emit("request", req, res);
    await ended;
    return { status, body: JSON.parse(body) as { blocks?: Array<{ ms: number }>; error?: string } };
  };
  const listed = await get(on);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.blocks![0]!.ms >= 150);
  assert.equal((await get(off)).status, 404);
});
