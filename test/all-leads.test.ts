import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import type { AllLeadsResult } from "../src/shared/types.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "all-leads-"));
  const root = join(dir, "repo");
  const project = join(dir, "project");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });
  git("init", root);
  git("-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init");
  git("-C", root, "worktree", "add", "-b", "project", project);
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const lane = (paneId: string, cwd: string): LiveAgent => ({ paneId, cwd, harness: "pi", sessionId: paneId, status: "idle", title: null, name: paneId });
  let live = [lane("project-lead", project), lane("project-crew", project), lane("standing-lead", root), lane("offline-lead", dir)];
  const original = live;
  const typed: { pane: string; text: string }[] = [];
  const none = async () => { throw new Error("unused"); };
  const world = new World(db, {
    available: () => true, live: () => live,
    prompt: async (pane, text) => { typed.push({ pane, text }); },
    notify: async () => {}, createWorktree: none, startAgent: none, closePane: none, removeWorktree: none,
  }, () => inbox.state());
  const standing = await world.createTeam({ name: "Mission Control", standing: true });
  const offlineTeam = await world.createTeam({ name: "Night shift", standing: true });
  const empty = await world.createTeam({ name: "Empty team", standing: true });
  for (const [pane, teamId] of [["standing-lead", standing.id], ["offline-lead", offlineTeam.id]]) {
    const a = world.state().agents.find((a) => a.paneId === pane)!;
    world.updateAgent(a.id, { teamId, role: "lead" });
  }
  const offline = world.state().agents.find((a) => a.paneId === "offline-lead")!;
  live = live.filter((a) => a.paneId !== "offline-lead");
  world.messages.uploads = inbox.uploads;
  return {
    db, inbox, world, typed, empty, offline,
    returnOffline: () => { live = original; },
    close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("one broadcast reaches project and standing leads once, queues offline leads, and stays a founder instruction", async () => {
  const f = await fixture();
  try {
    const { world, typed, empty, offline } = f;
    const leads = world.state().agents.filter((a) => a.role === "lead");
    assert.equal(leads.length, 3);
    const sent = world.messages.tellAllLeads({ text: "Report your priorities", clientId: "broadcast-1" });
    assert.equal(sent.message.allLeads, true);
    assert.equal(sent.message.kind, "instruction");
    assert.equal(sent.message.fromAgentId, null);
    assert.deepEqual(new Set(sent.message.deliveries.map((d) => d.agentId)), new Set(leads.map((a) => a.id)));
    assert.deepEqual(sent.queuedOffline, [offline.id]);
    assert.deepEqual(sent.skippedTeams, [empty.id]);
    await Promise.all([world.messages.deliver(world.state()), world.messages.deliver(world.state())]);
    assert.equal(typed.length, 2);
    assert.equal(new Set(typed.map((p) => p.pane)).size, 2);
    assert.ok(typed.every((p) => p.text.includes("Report your priorities") && p.text.includes("inbox say founder")));
    const projectLead = leads.find((a) => !world.state().teams.find((t) => t.id === a.teamId)!.standing)!;
    assert.match(typed.find((p) => p.pane === projectLead.paneId)!.text, /first mate/);
    assert.match(typed.find((p) => p.pane === "standing-lead")!.text, /Divide this among your crew/);
    assert.equal(world.messages.tellAllLeads({ text: "Report your priorities", clientId: "broadcast-1" }).message.id, sent.message.id);
    assert.throws(() => world.messages.tellAllLeads({ text: "different", clientId: "broadcast-1", leadIds: [] }), { status: 409, code: "replay_conflict" });
    assert.equal(world.messages.list().filter((m) => m.allLeads).length, 1);
    f.returnOffline();
    await world.messages.deliver(world.state());
    await world.messages.deliver(world.state());
    assert.equal(typed.length, 3);
    assert.equal(typed[2]!.pane, "offline-lead");
    assert.ok(world.messages.message(sent.message.id).deliveries.every((d) => d.state === "delivered"));
    assert.equal(world.messages.withFounder()[0]!.allLeads, true);
  } finally { f.close(); }
});

test("unticked leads hear nothing; duplicate ids, stale recipients and invalid images never partially fan out", async () => {
  const f = await fixture();
  try {
    const { world, typed } = f;
    const lead = world.state().agents.find((a) => a.paneId === "standing-lead")!;
    const body = { text: "Only you", clientId: "selected", leadIds: [lead.id, lead.id] };
    const sent = world.messages.tellAllLeads(body);
    assert.deepEqual(sent.message.deliveries.map((d) => d.agentId), [lead.id]);
    await world.messages.deliver(world.state());
    assert.deepEqual(typed.map((p) => p.pane), ["standing-lead"]);
    for (const leadIds of [[], [lead.id, "gone"], [42], "not a list"]) {
      assert.throws(() => world.messages.tellAllLeads({ ...body, clientId: "bad", leadIds: leadIds as string[] }));
    }
    assert.throws(() => world.messages.tellAllLeads({ ...body, clientId: "bad-image", images: ["missing.png"] }));
    assert.equal(world.messages.list().length, 1);
    for (let i = 0; i < 31; i++) world.messages.tellAllLeads({ ...body, clientId: `founder-${i}` });
    assert.equal(world.messages.list().length, 32);
  } finally { f.close(); }
});

test("broadcast HTTP endpoint accepts Attach images and applies the usual write guards", async () => {
  const f = await fixture();
  const port = 51000 + Math.floor(Math.random() * 1000);
  const server = createInboxServer(f.inbox, null, { port, staticDir: null, world: f.world });
  try {
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, body: unknown, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const upload = await post("/api/uploads", { data: PNG });
    const { id } = await upload.json();
    const path = "/api/world/all-leads/messages";
    assert.equal((await post(path, { text: "no", clientId: "evil" }, { origin: "https://evil.example" })).status, 403);
    const res = await post(path, { images: [id], clientId: "image-broadcast" });
    assert.equal(res.status, 200);
    const sent = await res.json() as AllLeadsResult;
    assert.deepEqual(sent.message.images, [id]);
    await f.world.messages.deliver(f.world.state());
    for (let i = 0; i < 50 && f.typed.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.typed.length, 2);
    assert.ok(f.typed.every((p) => p.text.includes(`Image: ${f.inbox.uploads.path(id)}`)));
    const retry = await post(path, { images: [id], clientId: "image-broadcast" });
    assert.equal((await retry.json()).message.id, sent.message.id);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});
