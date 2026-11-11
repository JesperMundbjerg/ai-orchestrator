import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { Waivers } from "../src/server/pipelines/waiver.ts";
import { needsYou } from "../src/ui/queue.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const agent = (id: string, role: "lead" | "member") => ({ id, name: id, identity: id, harness: "manual", cwd: null, teamId: "repairs", role, paneId: null, status: "working", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false }) as unknown as WorldAgent;

/** A scratch repository whose `dev` has two different repair commits waiting on separate branches. */
function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "waiver-withdraw-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"); mkdirSync(repo); git(repo, "init", "-q", "-b", "dev");
  writeFileSync(join(repo, "guard.ts"), "0\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const fix = (n: number) => { git(repo, "switch", "-qc", `repair-${n}`, "dev"); writeFileSync(join(repo, "guard.ts"), `${n}\n`); git(repo, "commit", "-qam", `repair ${n}`); return git(repo, "rev-parse", "HEAD"); };
  const [one, two, three] = [fix(1), fix(2), fix(3)] as [string, string, string];
  git(repo, "switch", "-q", "dev");
  const db = openDatabase(join(dir, "office.sqlite")); t.after(() => db.close());
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const lead = agent("captain", "lead"); const other = agent("other", "lead");
  const state = { agents: [lead, other], teams: [{ id: "repairs", name: "Repairs" }], work: [] } as unknown as WorldState;
  const waivers = new Waivers(db, () => state); waivers.inbox = inbox;
  const ask = (who: WorldAgent, candidate: string, clientId: string, ref = "dev") => waivers.request(who, { clientId, repo, ref, candidate, reason: "The guard blocks every push; this restores it." });
  const events = (kind: string) => db.prepare("SELECT detail FROM events WHERE kind = ?").all(kind).map((r) => JSON.parse(String(r.detail)));
  return { inbox, waivers, lead, other, one, two, three, ask, events };
}

test("the agent who asked withdraws a waiver by its key or item id; nobody else can, and a decided one stays", (t) => {
  const o = office(t);
  const w = o.ask(o.lead, o.one, "a");
  assert.equal(o.waivers.names(`waiver-${w.id}`), true);
  assert.equal(o.waivers.names("waiver-nope"), false);
  assert.throws(() => o.waivers.withdraw(o.other, `waiver-${w.id}`), /asked for by another agent/);
  assert.equal(o.inbox.item(w.itemId!).state, "needs_attention");

  const done = o.waivers.withdraw(o.lead, `waiver-${w.id}`)!;
  assert.equal(done.state, "expired");
  assert.equal(o.inbox.item(w.itemId!).state, "withdrawn");
  assert.deepEqual(needsYou(o.inbox.state(), "all", null), []);
  assert.deepEqual(o.events("pipeline.waiver.withdrawn").map((e) => e.note), ["withdrawn by the requester"]);
  assert.throws(() => o.waivers.withdraw(o.lead, `waiver-${w.id}`), /is expired/);

  const again = o.ask(o.lead, o.two, "b");
  o.waivers.withdraw(o.lead, again.itemId!); // the inbox item id works too
  assert.equal(o.inbox.item(again.itemId!).state, "withdrawn");
});

test("a new waiver on the same repo and ref withdraws that requester's older open ones, saying so", (t) => {
  const o = office(t);
  const old = o.ask(o.lead, o.one, "a");
  const theirs = o.ask(o.other, o.three, "x"); // another requester's request is not touched
  const fresh = o.ask(o.lead, o.two, "b");
  assert.equal(o.inbox.item(old.itemId!).state, "withdrawn");
  assert.equal(o.inbox.item(theirs.itemId!).state, "needs_attention");
  assert.equal(o.inbox.item(fresh.itemId!).state, "needs_attention");
  assert.deepEqual(o.waivers.list(fresh.repoRoot).map((x) => [x.id, x.state]).sort(), [[old.id, "expired"], [theirs.id, "requested"], [fresh.id, "requested"]].sort());
  assert.deepEqual(o.events("pipeline.waiver.withdrawn").map((e) => e.note), [`superseded by waiver-${fresh.id}`]);
  const history = o.inbox.detail(old.itemId!).history.find((h) => h.kind === "item.withdrawn");
  assert.equal(history?.detail.note, `superseded by waiver-${fresh.id}`);
  assert.equal(needsYou(o.inbox.state(), "all", null).length, 2);
});

test("the founder clearing a waiver item with Resolve closes the request without allowing anything", (t) => {
  const o = office(t);
  const w = o.ask(o.lead, o.one, "a");
  o.inbox.resolve(w.itemId!);
  o.waivers.sync();
  assert.equal(o.waivers.list(w.repoRoot)[0]!.state, "expired");
  assert.equal(o.waivers.gate(o.lead, { repo: w.repoRoot, ref: "refs/heads/dev", candidate: o.one, operation: "push" }).allowed, false);
  // The same commit can be asked for again: it no longer dedupes onto the cleared request.
  assert.notEqual(o.ask(o.lead, o.one, "b").id, w.id);
});
