import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";

let nextPort = 48_000 + Math.floor(Math.random() * 1000);

async function withServer(fn: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-http-"));
  const inbox = new Inbox(openDatabase(":memory:"), join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const port = nextPort++;
  const server = createInboxServer(inbox, null, { port, staticDir: null });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const submission = JSON.stringify({
  session: { harness: "manual", sessionId: "s1" },
  item: { type: "milestone", title: "Storyboard pass" },
});

test("the agent protocol accepts JSON from a local client", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent/items`, { method: "POST", headers: { "content-type": "application/json" }, body: submission });
    assert.equal(res.status, 200);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.items[0].title, "Storyboard pass");
  });
});

test("mutations from another website are refused", async () => {
  await withServer(async (base) => {
    const cross = await fetch(`${base}/api/agent/items`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: submission,
    });
    assert.equal(cross.status, 403);
    const form = await fetch(`${base}/api/agent/items`, { method: "POST", headers: { "content-type": "text/plain" }, body: submission });
    assert.equal(form.status, 415);
  });
});

test("a request for another host name is refused (DNS rebinding)", async () => {
  await withServer(async (base) => {
    // fetch drops a Host override, so this goes through node:http.
    const status = await new Promise<number>((resolve, reject) => {
      request(`${base}/api/state`, { headers: { host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject).end();
    });
    assert.equal(status, 403);
  });
});
