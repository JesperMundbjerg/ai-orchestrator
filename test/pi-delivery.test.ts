import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import reviewInbox from "../integrations/pi/review-inbox.ts";
import { Deliveries, DELIVERY_ENTRY } from "../integrations/pi/delivery.ts";
import type { PendingReply } from "../src/shared/types.ts";

const reply: PendingReply = { deliveryId: "reply-1", itemId: "item-1", itemKey: "layout", itemTitle: "Where should search go?", itemType: "decide", revision: 1, action: "choose", choice: "a", choiceLabel: "Docked", text: "", images: [], createdAt: "2026-01-01T00:00:00Z" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: unknown[] = [];
  const sent: { text: string; options: unknown }[] = [];
  const acks: any[] = [];
  let idle = true, lostAck = false, syncFailure = false;
  let sessionFile = "/tmp/pi-receipt.jsonl";
  const ctx = { cwd: "/tmp/lantern", sessionManager: { getSessionFile: () => sessionFile, getEntries: () => entries }, isIdle: () => idle };
  const api = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: () => {}, getThinkingLevel: () => "high", setThinkingLevel: () => {}, getSessionName: () => "demo",
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string, options: unknown) => {
      if (syncFailure) throw new Error("definite pre-receipt failure");
      sent.push({ text, options });
      // Real SDK wrapper returns void; async rejection is sent to Pi's runtime, not caller.
      void Promise.reject(new Error("compaction preflight rejected")).catch(() => {});
    },
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/ack")) {
      acks.push(body);
      if (lostAck) throw new Error("lost acknowledgement response");
    }
    const receipt = { id: reply.deliveryId, itemId: reply.itemId, revision: reply.revision, action: reply.action, choice: reply.choice, text: reply.text, images: [], state: body.error ? "failed" : "delivered", error: body.error ?? null, createdAt: reply.createdAt, deliveredAt: body.error ? null : reply.createdAt };
    return new Response(JSON.stringify(url.endsWith("/replies") ? [reply] : url.endsWith("/effort") ? { request: null } : url.endsWith("/ack") ? receipt : { ok: true }));
  });
  const load = () => { reviewInbox(api as unknown as Parameters<typeof reviewInbox>[0]); handlers.get("session_start")!({}, ctx); };
  const tick = async (ms = 2000) => { t.mock.timers.tick(ms); await flush(); };
  const receive = (text = sent.at(-1)!.text, file = sessionFile) => {
    const message = { role: "user", content: [{ type: "text", text }] };
    handlers.get("message_end")!({ message }, { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => file } });
    entries.push({ type: "message", message });
  };
  const shutdown = () => handlers.get("session_shutdown")!({}, ctx);
  t.after(shutdown);
  return { load, tick, receive, shutdown, sent, acks, entries, setIdle: (v: boolean) => { idle = v; }, setLostAck: (v: boolean) => { lostAck = v; }, setSyncFailure: (v: boolean) => { syncFailure = v; }, replace: () => { sessionFile = "/tmp/replacement.jsonl"; entries.length = 0; } };
}

test("async preflight rejection never acks success or repeats an uncertain send, including reload", async (t) => {
  const f = fixture(t); f.load(); await flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.acks.length, 0);
  await f.tick(); assert.equal(f.sent.length, 1); assert.equal(f.acks.length, 0);
  f.shutdown(); f.load(); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.acks.length, 0);
});

test("busy follow-up is acked only after user message receipt; unrelated/assistant messages do not count", async (t) => {
  const f = fixture(t); f.setIdle(false); f.load(); await flush();
  assert.deepEqual(f.sent[0]!.options, { deliverAs: "followUp" });
  assert.equal(f.acks.length, 0);
  f.receive("another message"); await f.tick(); assert.equal(f.acks.length, 0);
  f.receive(undefined, "/tmp/other-session.jsonl"); await f.tick(); assert.equal(f.acks.length, 0);
  f.receive(); await f.tick();
  assert.equal(f.acks.length, 1); assert.equal(f.acks[0].error, undefined); assert.equal(f.sent.length, 1);
});

test("lost ack retries only ack; receipts survive shutdown/reload and session replacement is isolated", async (t) => {
  const f = fixture(t); f.load(); await flush(); f.receive(); f.setLostAck(true); await f.tick();
  assert.equal(f.acks.length, 1);
  f.shutdown(); f.setLostAck(false); f.load(); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.acks.length, 2);
  f.shutdown(); const before = f.acks.length; await f.tick(20_000); assert.equal(f.acks.length, before);
  f.replace(); f.load(); await flush();
  assert.equal(f.sent.length, 2); assert.equal(f.acks.length, before, "old receipt must not acknowledge replacement session");
});

test("definite synchronous pre-receipt failure reports failure, retries its ack, and allows explicit retry", async (t) => {
  const f = fixture(t); f.setSyncFailure(true); f.setLostAck(true); f.load(); await flush();
  assert.match(f.acks[0].error, /definite pre-receipt failure/); assert.equal(f.sent.length, 0);
  f.shutdown(); f.setLostAck(false); f.load(); await flush();
  assert.match(f.acks[1].error, /definite pre-receipt failure/);
  f.setSyncFailure(false); await f.tick();
  assert.equal(f.sent.length, 1, "new poll after failure ack represents explicit service retry");
  assert.equal(f.acks.length, 2, "retry still requires receipt");
});

test("durability failure prevents sending, and journal restores actual user receipt after a crash", () => {
  const broken = new Deliveries("s", [], () => { throw new Error("disk full"); });
  assert.throws(() => broken.attempt("id", "body"), /disk full/);
  const entries: unknown[] = [];
  const persist = (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); };
  const first = new Deliveries("s", entries, persist);
  const text = first.attempt("id", "body")!;
  entries.push({ type: "message", message: { role: "assistant", content: text } });
  assert.equal(new Deliveries("s", entries, persist).acknowledgement("id"), undefined);
  entries.push({ type: "message", message: { role: "user", content: text } });
  const restored = new Deliveries("s", entries, persist);
  assert.deepEqual(restored.acknowledgement("id"), {});
  assert.equal(restored.attempt("id", "body"), null);
  assert.equal(new Deliveries("other", entries, persist).acknowledgement("id"), undefined);
  assert.ok(entries.some((e: any) => e.customType === DELIVERY_ENTRY));
});
