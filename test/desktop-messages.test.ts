import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { PendingMessage } from "../src/shared/types.ts";

// A desktop session (said hello, no herdr pane) collects the office's messages over HTTP and acknowledges them;
// collecting live keeps it running in the office. A herdr agent's messages are only ever typed into its pane.

const SECOND = 1000;

function office(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "desktop-messages-")));
  const db = openDatabase(":memory:");
  let at = Date.parse("2026-11-11T09:00:00Z");
  const now = () => new Date(at);
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null }, now);
  const live: LiveAgent[] = [];
  const typed: Array<{ paneId: string; text: string }> = [];
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    prompt: async (paneId, text) => { typed.push({ paneId, text }); },
    notify: async () => {},
    createWorktree: async () => { throw new Error("not in this test"); },
    startAgent: async () => {},
    closePane: async () => {},
    removeWorktree: async () => {},
  };
  const world = new World(db, source, () => inbox.state(), now);
  world.leadWatch.inbox = inbox;
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  // Samir runs in herdr, in a plain folder (no repository: no project), free for a prompt.
  live.push({ paneId: "p-samir", harness: "claude", sessionId: "samir", cwd: dir, status: "idle", title: null, name: null });
  const freja = { harness: "claude" as const, sessionId: "freja", cwd: dir };
  const samir = { harness: "claude" as const, sessionId: "samir", cwd: dir };
  world.hello(freja);
  const agent = (session: typeof freja) => world.resolve(session);
  return { db, inbox, world, typed, freja, samir, agent, pass: (ms: number) => { at += ms; } };
}

test("a message to a desktop session is collected over HTTP, never typed, and the sender sees it delivered once acknowledged", async (t) => {
  const o = office(t);
  const said = o.world.messages.say(o.agent(o.samir), { to: o.agent(o.freja).name, text: "Can you take the search page?" });
  await o.world.messages.deliver(o.world.state());
  assert.deepEqual(o.typed, [], "nobody types to a desktop session");

  const [first, ...rest] = o.world.collectMessages(o.freja, "pull");
  assert.equal(rest.length, 0);
  assert.equal(first!.messageId, said.id);
  assert.equal(first!.fromName, o.agent(o.samir).name);
  assert.equal(first!.text, "Can you take the search page?");
  assert.match(first!.prompt, /not from the founder/, "the sender's standing comes with it, as in a pane");
  assert.equal(o.world.collectMessages(o.freja, "boundary")[0]?.deliveryId, first!.deliveryId, "a re-poll before ack hands the same one out again");

  const ack = o.world.acknowledgeMessage(o.freja, first!.deliveryId);
  assert.equal(ack.state, "delivered");
  assert.equal(o.world.messages.message(said.id).deliveries[0]!.state, "delivered", "the sender sees it delivered");
  assert.deepEqual(o.world.collectMessages(o.freja, "pull"), [], "nothing is handed out after the ack");
  assert.equal(o.world.acknowledgeMessage(o.freja, said.id).state, "delivered", "acknowledging again, by message id, changes nothing");
});

test("an ack with an error fails the delivery with that error for its sender", (t) => {
  const o = office(t);
  const said = o.world.messages.say(o.agent(o.samir), { to: o.agent(o.freja).name, text: "hello" });
  const [m] = o.world.collectMessages(o.freja, "pull");
  assert.deepEqual(o.world.acknowledgeMessage(o.freja, m!.messageId, "context full"), { deliveryId: m!.deliveryId, messageId: said.id, state: "failed", error: "context full" });
  assert.equal(o.world.messages.message(said.id).deliveries[0]!.error, "context full");
});

test("an unacknowledged collection shows as uncertain after the grace and is handed out again until acknowledged", (t) => {
  const o = office(t);
  const said = o.world.messages.say(o.agent(o.samir), { to: o.agent(o.freja).name, text: "status?" });
  const [m] = o.world.collectMessages(o.freja, "boundary");
  assert.equal(o.world.messages.message(said.id).deliveries[0]!.error, null, "within the grace it simply waits for the ack");
  o.pass(31 * SECOND);
  const waiting = o.world.messages.message(said.id).deliveries[0]!;
  assert.equal(waiting.state, "queued");
  assert.match(waiting.error ?? "", /picked up by the session but not confirmed/);
  const [again] = o.world.collectMessages(o.freja, "pull");
  assert.equal(again?.deliveryId, m!.deliveryId, "the next collection recovers it");
  o.world.acknowledgeMessage(o.freja, again!.deliveryId);
  const settled = o.world.messages.message(said.id).deliveries[0]!;
  assert.deepEqual([settled.state, settled.error], ["delivered", null]);
});

test("collecting live makes a desktop session running in the office; when it stops it is offline again", (t) => {
  const o = office(t);
  const status = () => o.world.state().agents.find((a) => a.id === o.agent(o.freja).id)!.status;
  assert.equal(status(), "offline");
  const before = o.world.messages.say(o.agent(o.samir), { to: o.agent(o.freja).name, text: "one" });
  assert.ok(before.deliveries[0]!.offline, "the sender is told it is offline");

  o.world.collectMessages(o.freja, "pull");
  assert.equal(status(), "offline", "a pull is not listening");
  o.world.collectMessages(o.freja, "live");
  assert.equal(status(), "idle");
  const during = o.world.messages.say(o.agent(o.samir), { to: o.agent(o.freja).name, text: "two" });
  assert.equal(during.deliveries[0]!.offline, undefined, "no offline wording while it listens");
  assert.equal(o.world.state().messages.find((m) => m.id === during.id)!.deliveries[0]!.offline, undefined);

  o.pass(16 * SECOND);
  assert.equal(status(), "offline", "stopped polling: offline again");
  assert.ok(o.world.state().messages.find((m) => m.id === during.id)!.deliveries[0]!.offline);
});

test("a herdr agent's deliveries are never handed out, and the typist never types one an integration holds", async (t) => {
  const o = office(t);
  const said = o.world.messages.say(o.agent(o.freja), { to: o.agent(o.samir).name, text: "review please" });
  assert.deepEqual(o.world.collectMessages(o.samir, "live"), [], "a herdr agent's messages stay its pane's");
  assert.throws(() => o.world.acknowledgeMessage(o.samir, said.id), /not handed to this session/);

  // Should one ever be held by an integration (a claim from before the agent ran in herdr), the typist leaves it alone.
  o.db.prepare("UPDATE message_deliveries SET claim_transport = 'integration', claimed_at = ? WHERE message_id = ?").run(new Date().toISOString(), said.id);
  await o.world.messages.deliver(o.world.state());
  assert.equal(o.typed.length, 0, "held by an integration: not typed");
  o.db.prepare("UPDATE message_deliveries SET claim_transport = NULL, claimed_at = NULL WHERE message_id = ?").run(said.id);
  await o.world.messages.deliver(o.world.state());
  assert.deepEqual(o.typed.map((x) => x.paneId), ["p-samir"], "unclaimed, it is typed as ever");
  assert.equal(o.world.messages.message(said.id).deliveries[0]!.state, "delivered");
});

test("the HTTP routes collect and acknowledge", async (t) => {
  const o = office(t);
  const said = o.world.messages.say(o.agent(o.samir), { to: o.agent(o.freja).name, text: "over HTTP" });
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const server = createInboxServer(o.inbox, null, { port, staticDir: null, world: o.world });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const got = await post("/api/agent/messages", { session: o.freja, mode: "live" });
  assert.equal(got.status, 200);
  const [m] = await got.json() as PendingMessage[];
  assert.equal(m?.messageId, said.id);
  const ack = await post("/api/agent/messages/ack", { session: o.freja, deliveryId: m!.deliveryId });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json() as { state: string }).state, "delivered");
  const unknown = await post("/api/agent/messages/ack", { session: o.freja, deliveryId: "nope" });
  assert.equal(unknown.status, 404);
});
