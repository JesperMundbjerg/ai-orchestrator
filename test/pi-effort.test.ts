import { test } from "node:test";
import assert from "node:assert/strict";
import reviewInbox, { thinkingLevels } from "../integrations/pi/review-inbox.ts";

const model = { id: "gpt-6-astra", provider: "openai-codex", reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } };
test("Pi advertises supported model levels, not a vendor list in the UI", () => {
  assert.deepEqual(thinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(thinkingLevels({ ...model, reasoning: false }), ["off"]);
});

test("Pi waits until free, uses setter once, reports readback and external thinking events, and stops polling on shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map<string, (...args: any[]) => any>();
  const reports: any[] = [];
  let idle = false, sets = 0, calls = 0;
  let current = "high";
  const ctx = { cwd: "/tmp/pi-effort-test", model, sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getEntries: () => [] }, isIdle: () => idle };
  const api = {
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), registerTool: () => {},
    getSessionName: () => "test", getThinkingLevel: () => current,
    setThinkingLevel: (level: string) => { sets++; current = level; handlers.get("thinking_level_select")!({ level }, ctx); },
    appendEntry: () => {},
    sendUserMessage: () => assert.fail("effort must not prompt a model"),
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/events")) reports.push(...body.events);
    return new Response(JSON.stringify(url.endsWith("/effort") ? { request: { id: "change-1", level: "low" } } : url.endsWith("/replies") ? [] : { ok: true }));
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  reviewInbox(api as unknown as Parameters<typeof reviewInbox>[0]);
  handlers.get("session_start")!({}, ctx);
  await flush();
  assert.equal(sets, 0, "busy session must not change mid-turn");
  idle = true;
  t.mock.timers.tick(2000); await flush();
  assert.equal(sets, 1);
  assert.ok(reports.some((e) => e.effort?.current === "low" && e.effort?.result?.id === "change-1"));
  t.mock.timers.tick(2000); await flush();
  assert.equal(sets, 1, "lost ack must not reapply the setter");
  current = "medium";
  handlers.get("thinking_level_select")!({ level: "medium" }, ctx);
  await flush();
  assert.equal(reports.at(-1).effort.current, "medium");
  handlers.get("session_shutdown")!({}, ctx);
  const before = calls;
  t.mock.timers.tick(20_000); await flush();
  assert.equal(calls, before);
});
