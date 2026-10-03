import { test } from "node:test";
import assert from "node:assert/strict";
import reviewInbox from "../integrations/pi/review-inbox.ts";

test("Pi resends Codex's limits when only the credits change at 100%, down to none left, and not when nothing changed", async (t) => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const posted: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/agent/usage")) posted.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ changed: true }));
  });
  reviewInbox({ on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), registerTool: () => {} } as unknown as Parameters<typeof reviewInbox>[0]);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const reply = async (hasCredits: string, balance: string) => {
    handlers.get("after_provider_response")!({ status: 200, headers: {
      "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": "1791046697",
      "x-codex-credits-has-credits": hasCredits, "x-codex-credits-unlimited": "false", "x-codex-credits-balance": balance,
    } }, {});
    await flush();
  };
  await reply("true", "1240");
  await reply("true", "1240");
  assert.equal(posted.length, 1, "the same reading is sent once");
  await reply("true", "1180.5");
  await reply("false", "0");
  assert.equal(posted.length, 3, "a balance-only change is sent, and so is running out");
  assert.deepEqual(posted.map((p) => p.limits[0].credits), [
    { hasCredits: true, unlimited: false, balance: 1240 },
    { hasCredits: true, unlimited: false, balance: 1180.5 },
    { hasCredits: false, unlimited: false, balance: 0 },
  ]);
  assert.ok(posted.every((p) => p.provider === "codex" && p.limits[0].usedPercent === 100));
});
