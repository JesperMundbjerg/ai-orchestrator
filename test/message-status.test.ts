import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr } from "../src/server/herdr.ts";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const MIN = 60_000;
const BORDER = "─".repeat(45);
const IDLE = `Finished.\n${BORDER}\n \n${BORDER}\ngpt-example · high · ctx 33% 89k/272k\n`;
const WORKING = `Inspecting offline frames\n\x1b[38;2;178;148;187m── ⠋ Working ${"─".repeat(31)}\x1b[0m\n \n${BORDER}\ngpt-example · high · ctx 33% 89k/272k\n`;

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "message-status-"));
  const file = join(dir, "state.json"), log = join(dir, "calls.jsonl"), bin = join(dir, "herdr");
  const native = { status: "working", session: "s1", screen: WORKING, fail: false };
  const save = () => writeFileSync(file, JSON.stringify(native));
  save(); writeFileSync(log, "");
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), file = ${JSON.stringify(file)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'agent' && args[1] === 'list') console.log(JSON.stringify({result:{agents:[{pane_id:'w9:p1',agent:'pi',agent_session:{value:state.session},agent_status:state.status,screen_detection_skipped:true,name:'flight',cwd:null}]}}));
else if (args[0] === 'pane' && args[1] === 'read') { if(state.fail) process.exit(1); process.stdout.write(state.screen); }
else if (args[0] === 'agent' && args[1] === 'prompt') {
  // Like the real CLI this stand-in accepts working input. The OFFICE must prevent it.
  state.status = 'working'; state.screen = ${JSON.stringify(WORKING)};
  fs.writeFileSync(file, JSON.stringify(state)); console.log('{}');
} else console.log('{}');
`, { mode: 0o755 });
  let at = 0;
  const source = new Herdr(bin, join(dir, "missing.sock"), () => at);
  const db = openDatabase(":memory:");
  const now = () => new Date(at);
  const inbox = new Inbox(db, join(dir, "files"), source, now);
  const world = new World(db, source, () => inbox.state(), now);
  world.messages.replies = inbox;
  source.queuedPanes = () => world.messages.queuedPanes(world.state());
  t.after(() => { source.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s) as string[]);
  return { native, save, source, inbox, world, db, calls,
    advance: (ms: number) => { at += ms; },
    prompts: () => calls().filter((args) => args[0] === "agent" && args[1] === "prompt"),
    notices: () => world.messages.withFounder().filter((m) => m.fromOffice),
  };
}

test("a static Pi Working border is never free: office, reply presence, sender and watchdog agree", async (t) => {
  const s = setup(t);
  await s.source.refresh();
  const agent = s.world.state().agents[0]!;
  const first = s.world.messages.tell(agent.id, { text: "First instruction" });
  s.world.messages.tell(agent.id, { text: "Second instruction" });
  await s.source.refresh();
  // Identical spinner phases can alias the 30s sampler during a long capture/model/tool call.
  for (let i = 0; i < 24; i++) { s.advance(30_000); await s.source.refresh(); await s.world.react(); }
  assert.equal(s.world.state().agents[0]!.status, "working");
  assert.equal(s.source.forSession("pi", "s1")!.status, "working");
  assert.equal(s.prompts().length, 0);
  assert.equal(s.notices().length, 0);
  assert.equal(s.world.messages.message(first.id).deliveries[0]!.updatedAt, first.createdAt);
  assert.ok(s.world.messages.list().every((m) => m.deliveries[0]!.state === "queued"));
});

test("stale Pi lifecycle idle/done cannot submit into a visible active turn", async (t) => {
  for (const status of ["idle", "done"]) {
    const s = setup(t); s.native.status = status; s.save();
    await s.source.refresh();
    const snapshot = s.world.state();
    assert.equal(snapshot.agents[0]!.status, status, "no unrelated pane read before queuing");
    const message = s.world.messages.tell(snapshot.agents[0]!.id, { text: "Wait for turn end" });
    s.advance(14 * MIN);
    await s.world.messages.deliver(snapshot);
    assert.equal(s.prompts().length, 0);
    assert.equal(s.world.messages.message(message.id).deliveries[0]!.state, "queued");
    assert.equal(s.world.state().agents[0]!.status, "working");
    assert.equal(s.source.forSession("pi", "s1")!.status, "working");
    await s.world.react();
    assert.equal(s.notices().length, 0);
  }
});

test("really idle Pi recovers a stale working lifecycle signal and batches the waiting messages", async (t) => {
  const s = setup(t); s.native.screen = IDLE; s.save();
  await s.source.refresh();
  const id = s.world.state().agents[0]!.id;
  s.world.messages.tell(id, { text: "First instruction" });
  s.world.messages.tell(id, { text: "Second instruction" });
  await s.source.refresh();
  s.advance(3 * MIN); await s.source.refresh();
  assert.equal(s.world.state().agents[0]!.status, "idle");
  assert.equal(s.source.forSession("pi", "s1")!.status, "idle");
  await Promise.all([s.world.react(), s.world.react()]);
  assert.equal(s.prompts().length, 1);
  assert.match(s.prompts()[0]![3]!, /2 messages arrived[\s\S]*First instruction[\s\S]*Second instruction/);
  assert.ok(s.world.messages.list().every((m) => m.deliveries[0]!.state === "delivered"));
  assert.equal(s.world.state().agents[0]!.status, "working", "uptake clears the old idle evidence");
  assert.equal(s.notices().length, 0);
});

test("a cached free snapshot is rechecked without the sampling throttle before claiming", async (t) => {
  const s = setup(t); s.native.status = "idle"; s.native.screen = IDLE; s.save();
  await s.source.refresh();
  const snapshot = s.world.state(), agent = snapshot.agents[0]!;
  s.world.messages.tell(agent.id, { text: "New note" });
  await s.source.refresh(); // Establish a fresh idle sample.
  s.native.screen = WORKING; s.save(); // Only the lifecycle signal is stale now.
  await s.world.messages.deliver(snapshot); // Same clock, well within the 30s throttle.
  assert.equal(s.prompts().length, 0);
  assert.equal(s.world.state().agents[0]!.status, "working");
  assert.equal(s.world.messages.list()[0]!.deliveries[0]!.state, "queued");
});

test("the pre-claim guard also holds a fallback inbox reply without claiming it", async (t) => {
  const s = setup(t); s.native.status = "idle"; s.save();
  await s.source.refresh();
  const item = s.inbox.submit({ session: { harness: "pi", sessionId: "s1" }, project: { root: "/scratch/fictional" },
    item: { type: "milestone", key: "ready", title: "Ready" } });
  s.inbox.answer(item.itemId, { revision: item.revision, action: "accept" });
  const snapshot = s.world.state();
  await s.world.messages.deliver(snapshot);
  assert.equal(s.prompts().length, 0);
  assert.equal(s.inbox.typeable().length, 1, "still available at the real turn boundary");
});

test("tall, retry, compaction, custom-label and narrow Pi working borders veto stale recovery", async (t) => {
  for (const border of ["── ⠋ Retrying (1/3) ──────", "── ⠋ Compacting context ──────", "── ◇ Capturing frames ──────", "─⠋─"]) {
    const s = setup(t); s.native.screen = `${"Old output\n".repeat(100)}${border}\n \n${BORDER}\ngpt-example · ctx 33% 89k/272k`;
    s.save(); await s.source.refresh();
    s.world.messages.tell(s.world.state().agents[0]!.id, { text: "After the turn" });
    await s.source.refresh(); s.advance(14 * MIN); await s.source.refresh(); await s.world.react();
    assert.equal(s.world.state().agents[0]!.status, "working", border);
    assert.equal(s.prompts().length, 0, border);
    assert.equal(s.notices().length, 0, border);
    assert.ok(s.calls().filter((a) => a[0] === "pane").every((a) => !a.includes("--lines")), "read the whole visible pane, including its bottom");
  }
});

test("ambiguous quiet output does not disprove authoritative working; unreadable idle panes wait too", async (t) => {
  for (const screen of ["Quiet model output", IDLE.replace("\n \n", "\nUnsubmitted draft\n")]) {
    const s = setup(t); s.native.screen = screen; s.save();
    await s.source.refresh(); s.world.messages.tell(s.world.state().agents[0]!.id, { text: "Next note" });
    await s.source.refresh(); s.advance(14 * MIN); await s.source.refresh(); await s.world.react();
    assert.equal(s.world.state().agents[0]!.status, "working");
    assert.equal(s.prompts().length, 0);
    assert.equal(s.notices().length, 0);
  }
  for (const empty of [true, false]) {
    const s = setup(t); s.native.status = "idle"; s.native.screen = empty ? "" : IDLE; s.native.fail = !empty; s.save();
    await s.source.refresh(); s.world.messages.tell(s.world.state().agents[0]!.id, { text: "Next note" });
    await s.world.react();
    assert.equal(s.world.state().agents[0]!.status, "unknown");
    assert.equal(s.prompts().length, 0);
    assert.equal(s.world.messages.list()[0]!.deliveries[0]!.state, "queued");
  }
});

test("an asynchronous readiness check rechecks holds and per-agent delivery reservations", async (t) => {
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const live: LiveAgent[] = [{ paneId: "a", harness: "manual", sessionId: "s", cwd: null, status: "idle", title: null, name: null }];
  let release: () => void = () => {}, prompts = 0;
  const readiness = new Promise<void>((resolve) => { release = resolve; });
  const unused = async () => { throw new Error("unused"); };
  const source: AgentSource = { available: () => true, live: () => live, canPrompt: async () => { await readiness; return true; },
    prompt: async () => { prompts++; }, notify: async () => {}, createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused };
  const world = new World(db, source, () => ({ tasks: [], projects: [], items: [] }));
  const id = world.state().agents[0]!.id;
  world.messages.tell(id, { text: "Note" });
  const delivery = world.messages.deliver(world.state());
  world.messages.held = () => new Set([id]); release(); await delivery;
  assert.equal(prompts, 0);
  assert.equal(world.messages.list()[0]!.deliveries[0]!.state, "queued");
  world.messages.held = () => new Set();
  await Promise.all([world.messages.deliver(world.state()), world.messages.deliver(world.state())]);
  assert.equal(prompts, 1);
});
