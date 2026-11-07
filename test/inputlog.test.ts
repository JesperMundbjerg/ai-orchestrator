import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { InputLog } from "../src/server/inputlog.ts";
// @ts-expect-error: a plain .mjs script without types
import { summarize, windowsAround } from "../scripts/inputlog-summary.mjs";

async function withServer(fn: (base: string, origin: string) => Promise<void>, inputLog?: InputLog) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-inputlog-"));
  const inbox = new Inbox(openDatabase(":memory:"), join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const port = 49_000 + Math.floor(Math.random() * 1000);
  const server = createInboxServer(inbox, null, { port, staticDir: null, inputLog });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, `http://127.0.0.1:${port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

const post = (base: string, body: unknown, origin?: string) => fetch(`${base}/api/debug/inputlog`, {
  method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});

test("the input log keeps the newest events up to its capacity and reads them back oldest first", async () => {
  await withServer(async (base, origin) => {
    const empty = await (await fetch(`${base}/api/debug/inputlog`)).json();
    assert.deepEqual({ ...empty, events: empty.events.length }, { capacity: 3, total: 0, dropped: 0, events: 0 });
    const events = [1, 2, 3, 4, 5].map((n) => ({ kind: "keydown", t: n, code: "KeyV", meta: true }));
    assert.equal((await post(base, { events }, origin)).status, 200);
    const log = await (await fetch(`${base}/api/debug/inputlog`)).json();
    assert.equal(log.total, 5);
    assert.equal(log.dropped, 2);
    assert.deepEqual(log.events.map((e: { t: number }) => e.t), [3, 4, 5]);
    assert.equal(log.events[0].code, "KeyV");
  }, new InputLog(3));
});

test("the input log takes batches only from the office's own page", async () => {
  await withServer(async (base) => {
    const batch = { events: [{ kind: "paste", t: 1 }] };
    assert.equal((await post(base, batch, "https://evil.example")).status, 403);
    assert.equal((await post(base, batch)).status, 403, "no Origin: not a page of this office");
    assert.equal((await (await fetch(`${base}/api/debug/inputlog`)).json()).total, 0);
  });
});

test("the input log drops nested values and cuts long strings, so a stray text field stays short", async () => {
  await withServer(async (base, origin) => {
    await post(base, { events: [{ kind: "input", t: 1, nested: { text: "secret" }, label: "x".repeat(500) }] }, origin);
    const [e] = (await (await fetch(`${base}/api/debug/inputlog`)).json()).events;
    assert.equal(e.nested, undefined);
    assert.equal(e.label.length, 120);
    assert.equal((await post(base, { events: [{ t: 1 }] }, origin)).status, 400);
  });
});

test("the summary puts the events and overlapping long tasks around each Cmd+V together", () => {
  const ev = (t: number, kind: string, extra = {}) => ({ tab: "a", t, wall: 1_700_000_000_000 + t, kind, ...extra });
  const events = [
    ev(100, "keydown", { code: "KeyA" }),
    ev(4000, "longtask", { duration: 1200 }),
    ev(5000, "keydown", { code: "KeyV", key: "v", meta: true }),
    ev(5100, "keydown", { code: "KeyV", key: "v", meta: true }),
    ev(5900, "paste", { types: ["Files"], textLength: 0, fileCount: 1, defaultPrevented: true }),
    ev(9000, "keyup", { code: "KeyV" }),
    ev(20_000, "paste", { types: ["text/plain"], textLength: 12 }),
  ];
  const windows = windowsAround(events);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].anchors.length, 3);
  assert.deepEqual(windows[0].events.map((e: { t: number }) => e.t), [5000, 5100, 5900]);
  assert.deepEqual(windows[0].longTasks.map((e: { t: number }) => e.t), [4000], "started before the window, overlaps it");
  const text = summarize({ capacity: 5000, total: events.length, dropped: 0, events });
  assert.match(text, /▶ paste .*types=Files.*PREVENTED/);
  assert.match(text, /long tasks overlapping/);
});
