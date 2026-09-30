import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { formatReply } from "../src/shared/agent-client.ts";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { MAX_UPLOAD_BYTES } from "../src/server/uploads.ts";
import { World, type LiveAgent } from "../src/server/world.ts";

let nextPort = 49_000 + Math.floor(Math.random() * 1000);

// The smallest valid PNG: one transparent pixel.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function withOffice(fn: (o: { base: string; inbox: Inbox; typed: string[] }) => Promise<void>, live: LiveAgent[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-uploads-"));
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const typed: string[] = [];
  const none = async () => { throw new Error("not in this test"); };
  const world = new World(db, {
    available: () => true, live: () => live, prompt: async (pane, text) => void typed.push(`${pane}: ${text}`), notify: async () => {},
    createWorktree: none, startAgent: none, closePane: none, removeWorktree: none,
  }, () => inbox.state());
  world.messages.uploads = inbox.uploads;
  const port = nextPort++;
  const server = createInboxServer(inbox, null, { port, staticDir: null, world });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    await fn({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, inbox, typed });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const upload = (base: string, data: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/uploads`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ data }) });

test("a pasted image is stored under the data directory and served back as an image", async () => {
  await withOffice(async ({ base, inbox }) => {
    const res = await upload(base, `data:image/png;base64,${PNG.toString("base64")}`);
    assert.equal(res.status, 200);
    const { id, url } = await res.json();
    assert.match(id, /^[0-9a-f-]{36}\.png$/);
    assert.equal(url, `/uploads/${id}`);
    assert.ok(inbox.uploads.path(id)?.startsWith(inbox.uploads.dir));

    const back = await fetch(`${base}${url}`);
    assert.equal(back.status, 200);
    assert.equal(back.headers.get("content-type"), "image/png");
    assert.equal(back.headers.get("x-content-type-options"), "nosniff");
    assert.equal(back.headers.get("content-security-policy"), "sandbox");
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), PNG);
  });
});

test("only images of an allowed type and size are taken, whatever they claim to be", async () => {
  await withOffice(async ({ base }) => {
    // The type comes from the bytes: text dressed up as a PNG is refused.
    const text = await upload(base, `data:image/png;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`);
    assert.equal(text.status, 415);
    const svg = await upload(base, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"));
    assert.equal(svg.status, 415);

    const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    const tooBig = await upload(base, big.toString("base64"));
    assert.equal(tooBig.status, 413);

    assert.equal((await upload(base, "")).status, 400);
  });
});

test("an upload follows the same guards as every other write", async () => {
  await withOffice(async ({ base }) => {
    const data = PNG.toString("base64");
    assert.equal((await upload(base, data, { origin: "https://evil.example" })).status, 403);
    const raw = await fetch(`${base}/api/uploads`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    assert.equal(raw.status, 415);
    // Only an upload's own id is served: no paths out of the upload folder.
    assert.equal((await fetch(`${base}/uploads/..%2Finbox.sqlite`)).status, 404);
    assert.equal((await fetch(`${base}/uploads/nothing.png`)).status, 404);
  });
});

test("a message with images is typed as text naming each image's absolute path, never its bytes", async () => {
  const live: LiveAgent[] = [{ paneId: "p1", harness: "claude", sessionId: "c1", cwd: "/repo", status: "idle", title: null, name: null }];
  await withOffice(async ({ base, inbox, typed }) => {
    const { id } = await (await upload(base, PNG.toString("base64"))).json();
    const world = await (await fetch(`${base}/api/world`)).json();
    const agent = world.agents[0];
    const post = (body: unknown) =>
      fetch(`${base}/api/world/agents/${agent.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    assert.equal((await post({ text: "look", images: ["00000000-0000-0000-0000-000000000000.png"] })).status, 400, "only stored uploads can be attached");

    // An image can be the whole message.
    const res = await post({ text: "", images: [id], clientId: "m1" });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).images, [id]);
    for (let i = 0; i < 50 && !typed.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(typed.length, 1);
    const path = join(inbox.uploads.dir, id);
    assert.ok(isAbsolute(path));
    assert.ok(typed[0]!.includes(`\n\nImage: ${path}\n\n`), typed[0]);
    assert.ok(!typed[0]!.includes(PNG.toString("base64")));

    // The thread shows it: the founder's conversation carries the image by id.
    const after = await (await fetch(`${base}/api/world`)).json();
    assert.deepEqual(after.withFounder[0].images, [id]);
  }, live);
});

test("an answer with images reaches the agent with each image's path", async () => {
  await withOffice(async ({ base, inbox }) => {
    const session = { harness: "manual" as const, sessionId: "s1" };
    const submitted = await (await fetch(`${base}/api/agent/items`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, item: { type: "milestone", title: "Storyboard pass" } }),
    })).json();
    const itemId = submitted.itemId;
    const { id } = await (await upload(base, PNG.toString("base64"))).json();

    const answer = (body: unknown) =>
      fetch(`${base}/api/items/${itemId}/replies`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await answer({ revision: 1, action: "discuss", text: "", images: ["../inbox.sqlite"] })).status, 400);
    const res = await answer({ id: "r1", revision: 1, action: "discuss", text: "", images: [id] });
    assert.equal(res.status, 200, "an image alone is something to say");
    assert.deepEqual((await res.json()).images, [id]);

    const [pending] = inbox.pendingReplies(session, "pull");
    assert.deepEqual(pending!.images, [join(inbox.uploads.dir, id)]);
    assert.match(formatReply(pending!), new RegExp(`\\n\\nImage: ${join(inbox.uploads.dir, id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  });
});
