import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { AutoApprove } from "../src/server/autoapprove.ts";
import { Waivers, WAIVER_FOLLOW_UP_MS, WAIVER_TTL_MS } from "../src/server/pipelines/waiver.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const agent = (id: string, role: "lead" | "member", status = "working") => ({ id, name: id, identity: id, harness: "manual", cwd: null, teamId: "repairs", role, paneId: null, status, helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false }) as unknown as WorldAgent;

/** A scratch repository with `dev` at a base commit and an unmerged repair commit on top of it. */
function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-waiver-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"); mkdirSync(repo); git(repo, "init", "-q", "-b", "dev");
  writeFileSync(join(repo, "guard.ts"), "export const guard = false;\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-qc", "repair"); writeFileSync(join(repo, "guard.ts"), "export const guard = true;\n"); git(repo, "commit", "-qam", "repair the guard");
  const repair = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "dev");
  let clock = new Date("2026-10-03T08:00:00Z");
  const now = () => clock;
  const db = openDatabase(join(dir, "office.sqlite")); t.after(() => db.close());
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null }, now);
  const lead = agent("captain", "lead"); const crew = agent("deckhand", "member");
  const state = { agents: [lead, crew], teams: [{ id: "repairs", name: "Repairs" }], work: [] } as unknown as WorldState;
  const waivers = new Waivers(db, () => state, now); waivers.inbox = inbox;
  const ask = (who: WorldAgent = lead, over: Partial<{ clientId: string; repo: string; ref: string; candidate: string; reason: string }> = {}) =>
    waivers.request(who, { clientId: "ask-1", repo, ref: "dev", candidate: repair, reason: "The Pi guard blocks every push; this one-line fix restores it.", ...over });
  const allow = (itemId: string, choice = "allow") => inbox.answer(itemId, { revision: inbox.item(itemId).revision, action: "choose", choice });
  const gate = (over: Partial<{ repo: string; ref: string; candidate: string; operation: "push" | "land" | "publish" | "pr" }> = {}) =>
    waivers.gate(lead, { repo, ref: "refs/heads/dev", candidate: repair, operation: "push", ...over });
  const events = (kind: string) => db.prepare("SELECT detail FROM events WHERE kind = ?").all(kind).map(r => JSON.parse(String(r.detail)));
  return { dir, repo, base, repair, db, inbox, waivers, lead, crew, state, ask, allow, gate, events, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

test("a lead's request is one founder decision naming the repo, ref, exact commit, diff and reason, and nothing is allowed before the founder allows it", t => {
  const o = office(t);
  const w = o.ask();
  assert.equal(w.state, "requested");
  assert.equal(w.candidate, o.repair); assert.equal(w.base, o.base); assert.equal(w.targetRef, "refs/heads/dev"); assert.equal(w.requesterRole, "lead");
  const item = o.inbox.item(w.itemId!);
  assert.equal(item.state, "needs_attention"); assert.equal(item.type, "decide");
  assert.match(item.title, new RegExp(`${o.repair.slice(0, 10)} to dev`));
  assert.match(item.request, new RegExp(o.repair)); assert.match(item.request, /Pi guard blocks every push/); assert.match(item.request, new RegExp(o.repo));
  assert.match(item.context, /guard\.ts \| 2 \+-/, "the diff stat");
  assert.match(item.context, /-export const guard = false;\n\+export const guard = true;/, "the diff itself");
  assert.equal(item.recommendation, "", "no recommendation for approve-all to pick");
  assert.deepEqual(o.events("pipeline.waiver.requested").map(e => e.waiverId), [w.id]);

  const waiting = o.gate();
  assert.equal(waiting.allowed, false);
  assert.match(waiting.reasons.join(), /waiting for the founder/);
});

test("a granted waiver allows exactly that delivery once: the same delivery's later boundaries pass, then nothing after it lands or its window ends", t => {
  const o = office(t);
  const w = o.ask(); o.allow(w.itemId!);
  const first = o.gate({ operation: "land" });
  assert.equal(first.allowed, true); assert.equal(first.waiverId, w.id);
  assert.equal(o.waivers.list(o.repo)[0]!.state, "used");
  assert.equal(o.inbox.item(w.itemId!).state, "resolved", "the founder's item is closed once decided");
  // Git's pre-push for that same push still passes while dev has not moved.
  assert.equal(o.gate({ operation: "push" }).allowed, true);
  assert.equal(o.events("pipeline.waiver.used").length, 1);
  assert.equal(o.events("pipeline.waiver.allowed").length, 1);

  git(o.repo, "merge", "-q", "--ff-only", o.repair); // the delivery lands
  const after = o.gate();
  assert.equal(after.allowed, false);
  assert.match(after.reasons.join(), /already points to it/);

  // Without landing, the follow-up window still ends it.
  const p = office(t);
  const v = p.ask(); p.allow(v.itemId!);
  assert.equal(p.gate().allowed, true);
  p.advance(WAIVER_FOLLOW_UP_MS + 1);
  const late = p.gate();
  assert.equal(late.allowed, false);
  assert.match(late.reasons.join(), /allows one delivery/);
});

test("a waiver never allows another commit, another branch or another repository", t => {
  const o = office(t);
  const w = o.ask(); o.allow(w.itemId!);
  git(o.repo, "switch", "-qc", "other", o.repair); writeFileSync(join(o.repo, "more.ts"), "x\n"); git(o.repo, "add", "."); git(o.repo, "commit", "-qm", "more");
  const other = git(o.repo, "rev-parse", "HEAD"); git(o.repo, "switch", "-q", "dev");
  const wrongSha = o.gate({ candidate: other });
  assert.equal(wrongSha.allowed, false); assert.match(wrongSha.reasons.join(), /none allows/);

  git(o.repo, "branch", "staging", o.base);
  const wrongRef = o.gate({ ref: "staging" });
  assert.equal(wrongRef.allowed, false); assert.match(wrongRef.reasons.join(), /names dev, not staging/);

  const clone = join(o.dir, "clone"); git(o.dir, "clone", "-q", o.repo, clone); git(clone, "fetch", "-q", "origin", "repair");
  const wrongRepo = o.gate({ repo: clone });
  assert.equal(wrongRepo.allowed, false); assert.match(wrongRepo.reasons.join(), /none allows/);

  assert.equal(o.gate({ operation: "pr" }).allowed, false, "never a PR or merge");
  assert.equal(o.waivers.list(o.repo)[0]!.state, "granted", "refusals do not consume it");
  assert.equal(o.gate().allowed, true);
  assert.ok(o.events("pipeline.waiver.gate_refused").length >= 4, "refusals are logged");
});

test("a waiver works only while the branch still points where the founder's diff was taken from", t => {
  const o = office(t);
  const w = o.ask(); o.allow(w.itemId!);
  writeFileSync(join(o.repo, "unrelated.ts"), "y\n"); git(o.repo, "add", "."); git(o.repo, "commit", "-qm", "someone else landed");
  const moved = o.gate();
  assert.equal(moved.allowed, false);
  assert.match(moved.reasons.join(), new RegExp(`dev moved since the founder saw the diff \\(refs/heads/dev was ${o.base.slice(0, 10)}`));
  assert.equal(o.waivers.list(o.repo)[0]!.state, "granted", "not consumed by a refusal");
});

test("the branch position is read from origin's remote-tracking ref when there is one", t => {
  const o = office(t);
  const remote = join(o.dir, "remote.git"); git(o.dir, "init", "-q", "--bare", remote);
  git(o.repo, "remote", "add", "origin", remote); git(o.repo, "push", "-q", "origin", "dev");
  const w = o.ask(); assert.equal(w.targetRef, "refs/remotes/origin/dev");
  o.allow(w.itemId!);
  // Landing locally first (land, then publish) does not move origin/dev, so publish still passes.
  assert.equal(o.gate({ operation: "land" }).allowed, true);
  git(o.repo, "merge", "-q", "--ff-only", o.repair);
  assert.equal(o.gate({ operation: "publish" }).allowed, true);
  git(o.repo, "push", "-q", "origin", "dev");
  assert.equal(o.gate().allowed, false, "once published it is spent");
});

test("a granted waiver lapses 24 hours after the founder allows it, and an unanswered request lapses too", t => {
  const o = office(t);
  const w = o.ask();
  o.advance(WAIVER_TTL_MS - 60_000); o.allow(w.itemId!);
  o.advance(WAIVER_TTL_MS - 1000);
  assert.equal(o.waivers.list(o.repo)[0]!.state, "granted", "the 24 hours start at the founder's Allow");
  o.advance(2000);
  const late = o.gate();
  assert.equal(late.allowed, false); assert.match(late.reasons.join(), /expired/);
  assert.equal(o.waivers.list(o.repo)[0]!.state, "expired");
  assert.equal(o.events("pipeline.waiver.expired").length, 1);

  const p = office(t);
  const v = p.ask();
  p.advance(WAIVER_TTL_MS + 1);
  p.waivers.sync();
  assert.equal(p.waivers.list(p.repo)[0]!.state, "expired");
  assert.equal(p.inbox.item(v.itemId!).state, "withdrawn", "an unanswered request leaves Needs you");
  assert.throws(() => p.allow(v.itemId!), /withdrawn/);
});

test("approve all never answers a waiver request; it stays for the founder", t => {
  const o = office(t);
  const auto = new AutoApprove(o.db, o.inbox);
  auto.setEnabled(true);
  const w = o.ask();
  auto.sweep();
  assert.equal(o.inbox.item(w.itemId!).state, "needs_attention");
  assert.equal(o.db.prepare("SELECT count(*) AS n FROM replies WHERE item_id = ?").get(w.itemId!)!.n, 0);
  assert.equal(o.gate().allowed, false);

  // Even an automatic answer that reached it some other way grants nothing.
  o.inbox.answer(w.itemId!, { id: `approve-all:${w.itemId}:1`, revision: 1, action: "choose", choice: "allow", text: "Auto-approved (approve all)." }, "approve_all");
  o.waivers.sync();
  assert.equal(o.waivers.list(o.repo)[0]!.state, "requested");
  assert.equal(o.gate().allowed, false);
});

test("the QA agent is never offered a waiver and cannot answer it; a QA answer that reached it grants nothing", t => {
  const o = office(t);
  const auto = new AutoApprove(o.db, o.inbox);
  const qa = { id: "deckhand", name: "deckhand", online: true, taskIds: [] };
  auto.qa.office = { agent: (id) => (id === qa.id ? qa : null), resolve: () => qa, notice: () => {} };
  auto.setMode("qa", "deckhand");
  const w = o.ask();
  const session = { harness: "manual" as const, sessionId: "deckhand" };
  assert.equal(auto.qa.next(session).item, null);
  assert.throws(() => auto.qa.answer({ session, item: w.itemId!, revision: 1, action: "choose", choice: "allow", reason: "r" }), /stays with the founder: a repair waiver/);
  assert.equal(o.inbox.item(w.itemId!).state, "needs_attention");
  o.inbox.answer(w.itemId!, { id: `qa:${w.itemId}:1`, revision: 1, action: "choose", choice: "allow", text: "QA" }, "qa_agent");
  o.waivers.sync();
  assert.equal(o.waivers.list(o.repo)[0]!.state, "requested");
  assert.equal(o.gate().allowed, false);
});

test("a message never revokes a granted waiver, and a message before deciding puts the request back in Needs you", t => {
  const o = office(t);
  const w = o.ask();
  o.allow(w.itemId!);
  o.inbox.answer(w.itemId!, { revision: 1, action: "discuss", text: "Thanks, go ahead" });
  o.waivers.sync();
  assert.equal(o.waivers.list(o.repo)[0]!.state, "granted");
  assert.throws(() => o.inbox.answer(w.itemId!, { revision: 1, action: "discuss", text: "one more thing" }), /resolved/);
  assert.equal(o.gate().allowed, true);

  const p = office(t);
  const v = p.ask();
  p.inbox.answer(v.itemId!, { revision: 1, action: "discuss", text: "Why not a run?" });
  p.waivers.sync();
  const item = p.inbox.item(v.itemId!);
  assert.equal(p.waivers.list(p.repo)[0]!.state, "requested", "a message is not a decision");
  assert.equal(item.state, "needs_attention"); assert.equal(item.revision, 2);
  assert.match(item.context, /Why not a run\?/);
  p.allow(v.itemId!, "refuse");
  assert.equal(p.waivers.list(p.repo)[0]!.state, "refused");
  assert.match(p.gate().reasons.join(), /refused/);
});

test("crew may ask only while their team has no lead online, and their request still needs the founder", t => {
  const o = office(t);
  assert.throws(() => o.ask(o.crew), { status: 403, code: "pipeline_lead_required" });
  (o.state.agents[0] as { status: string }).status = "offline";
  const w = o.ask(o.crew);
  assert.equal(w.requesterRole, "crew");
  assert.match(o.inbox.item(w.itemId!).request, /deckhand \(crew; captain, the lead, is offline\)/);
  assert.equal(o.waivers.gate(o.crew, { repo: o.repo, ref: "dev", candidate: o.repair }).allowed, false);
  o.allow(w.itemId!);
  assert.equal(o.waivers.gate(o.crew, { repo: o.repo, ref: "dev", candidate: o.repair }).allowed, true);
});

test("a request retried with the same client id is the same waiver and the same single item", t => {
  const o = office(t);
  const w = o.ask();
  assert.deepEqual(o.ask(), w);
  assert.throws(() => o.ask(o.lead, { reason: "a different reason" }), { status: 409, code: "replay_conflict" });
  // A fresh id for the same commit, branch and base while one waits is the same question too.
  assert.equal(o.ask(o.lead, { clientId: "ask-2" }).id, w.id);
  assert.equal(o.db.prepare("SELECT count(*) AS n FROM items").get()!.n, 1);
  assert.equal(o.events("pipeline.waiver.requested").length, 1);
  o.allow(w.itemId!);
  o.waivers.sync(); o.waivers.sync();
  assert.equal(o.events("pipeline.waiver.granted").length, 1, "syncing again records nothing new");
  assert.equal(o.ask().id, w.id, "a late retry still answers with the same waiver, as it stands now");
  assert.equal(o.ask().state, "granted");
});

test("requests that would rewind the branch, name main or name a ref instead of a commit are refused", t => {
  const o = office(t);
  assert.throws(() => o.ask(o.lead, { candidate: o.base }), { code: "pipeline_waiver_noop" });
  assert.throws(() => o.ask(o.lead, { candidate: "repair" }), { status: 400 });
  git(o.repo, "branch", "main", o.base);
  assert.throws(() => o.ask(o.lead, { ref: "main" }), { code: "pipeline_waiver_ref" });
  writeFileSync(join(o.repo, "ahead.ts"), "z\n"); git(o.repo, "add", "."); git(o.repo, "commit", "-qm", "dev moved on");
  assert.throws(() => o.ask(o.lead, { clientId: "ask-3" }), { code: "pipeline_waiver_not_descendant" });
});

test("migration 11 adds the waiver ledger to a version-10 database without touching its data", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-waiver-v10-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "office.sqlite");
  const first = openDatabase(file);
  first.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('kept', 'Kept', 1, 'now')").run();
  first.close();
  // Wind the file back to how version 10 left it.
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE pipeline_waivers; PRAGMA user_version = 10;");
  raw.close();
  const db = openDatabase(file); t.after(() => db.close());
  assert.ok(Number(db.prepare("PRAGMA user_version").get()!.user_version) >= 11);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'pipeline_waivers'").get());
  assert.equal(db.prepare("SELECT name FROM teams WHERE id = 'kept'").get()!.name, "Kept");
});
