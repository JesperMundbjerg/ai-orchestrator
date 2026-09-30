import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr } from "../src/server/herdr.ts";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World } from "../src/server/world.ts";
import { WaitingMessages } from "../src/server/waiting.ts";
import { waitingLabel } from "../src/shared/waiting.ts";
import type { Message } from "../src/shared/types.ts";

const MIN = 60_000;
function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "stale-herdr-"));
  const state = { status: "working", harness: "claude", session: "s1", screen: "Ready for a prompt", fail: false };
  const file = join(dir, "state.json"), log = join(dir, "calls.jsonl"), bin = join(dir, "herdr");
  const save = () => writeFileSync(file, JSON.stringify(state));
  save(); writeFileSync(log, "");
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'agent' && args[1] === 'list') console.log(JSON.stringify({result:{agents:[{pane_id:'w9:p1',agent:state.harness,agent_session:{value:state.session},agent_status:state.status,cwd:'/scratch/emil'}]}}));
else if (args[0] === 'pane' && args[1] === 'read') { if(state.fail) process.exit(1); process.stdout.write(state.screen); }
else console.log('{}');\n`, { mode: 0o755 });
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const herdr = new Herdr(bin, join(dir, "missing.sock"), () => clock);
  t.after(() => { herdr.stop(); rmSync(dir, { recursive: true, force: true }); });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s) as string[]);
  return { dir, state, save, herdr, calls, now: () => new Date(clock), advance: (ms: number) => { clock += ms; }, reads: () => calls().filter((a) => a[0] === "pane").length };
}

test("fake herdr: unchanged visible content is stale after three observed minutes; both presence paths agree", async (t) => {
  const o = setup(t);
  o.herdr.queuedPanes = () => new Set(["w9:p1"]);
  await o.herdr.refresh();
  for (let i = 0; i < 5; i++) { o.advance(30_000); await o.herdr.refresh(); }
  assert.equal(o.herdr.live()[0]!.status, "working");
  let changes = 0; o.herdr.onChange = () => { changes++; };
  o.advance(30_000); await o.herdr.refresh();
  assert.equal(o.herdr.live()[0]!.status, "idle");
  assert.equal(o.herdr.forSession("claude", "s1")!.status, "idle");
  assert.equal(changes, 1, "staleness wakes delivery and redraws the office");
  o.state.screen = "Working 1s"; o.save(); o.advance(30_000); await o.herdr.refresh();
  assert.equal(o.herdr.live()[0]!.status, "working");
});

test("fake herdr: changing content never goes stale; rapid refreshes do not read panes", async (t) => {
  const o = setup(t); o.herdr.queuedPanes = () => new Set(["w9:p1"]);
  await o.herdr.refresh();
  await Promise.all([o.herdr.refresh(), o.herdr.refresh(), o.herdr.refresh()]);
  assert.equal(o.reads(), 1);
  for (let i = 0; i < 15; i++) {
    o.advance(30_000); o.state.screen = `Working ${i}s`; o.save(); await o.herdr.refresh();
    assert.equal(o.herdr.live()[0]!.status, "working");
  }
});

test("fake herdr: no reads without a queue or a long-working agent, and long-working alone is not stale", async (t) => {
  const o = setup(t); await o.herdr.refresh();
  o.advance(179_999); await o.herdr.refresh(); assert.equal(o.reads(), 0);
  o.advance(1); await o.herdr.refresh(); assert.equal(o.reads(), 1);
  assert.equal(o.herdr.live()[0]!.status, "working");
  o.advance(3 * MIN); await o.herdr.refresh(); assert.equal(o.herdr.live()[0]!.status, "idle");
  o.herdr.queuedPanes = () => new Set(["w9:p1"]);
  o.state.status = "blocked"; o.save(); await o.herdr.refresh();
  const reads = o.reads(); o.advance(10 * MIN); await o.herdr.refresh(); assert.equal(o.reads(), reads);
  assert.equal(o.herdr.live()[0]!.status, "blocked");
});

test("fake herdr: staleness is the same for other harnesses, with no prompt/title parsing", async (t) => {
  const o = setup(t); o.herdr.queuedPanes = () => new Set(["w9:p1"]);
  for (const harness of ["pi", "codex"] as const) {
    o.state.harness = harness; o.state.screen = "any unchanged screen"; o.save();
    await o.herdr.refresh(); assert.equal(o.herdr.live()[0]!.status, "working");
    o.advance(3 * MIN); await o.herdr.refresh();
    assert.equal(o.herdr.forSession(harness, "s1")!.status, "idle");
  }
});

test("fake herdr: failed or empty reads and replacement sessions discard evidence", async (t) => {
  const o = setup(t); o.herdr.queuedPanes = () => new Set(["w9:p1"]);
  await o.herdr.refresh(); o.advance(3 * MIN); o.state.fail = true; o.save(); await o.herdr.refresh();
  assert.equal(o.herdr.live()[0]!.status, "working");
  o.state.fail = false; o.save(); o.advance(30_000); await o.herdr.refresh();
  o.advance(3 * MIN); await o.herdr.refresh(); assert.equal(o.herdr.live()[0]!.status, "idle");
  o.state.session = "s2"; o.save(); await o.herdr.refresh(); assert.equal(o.herdr.live()[0]!.status, "working");
  o.state.screen = ""; o.save(); o.advance(3 * MIN); await o.herdr.refresh(); assert.equal(o.herdr.live()[0]!.status, "working");
});

test("fake herdr: a stale agent takes its queued messages in the existing single batched prompt", async (t) => {
  const o = setup(t), db = openDatabase(":memory:"); t.after(() => db.close());
  const inbox = new Inbox(db, join(o.dir, "files"), o.herdr, o.now);
  const world = new World(db, o.herdr, () => inbox.state(), o.now);
  world.messages.replies = inbox;
  o.herdr.queuedPanes = () => world.messages.queuedPanes(world.state());
  await o.herdr.refresh();
  const agent = world.state().agents[0]!;
  world.messages.tell(agent.id, { text: "First note" });
  world.messages.tell(agent.id, { text: "Second note" });
  await o.herdr.refresh(); await world.react();
  assert.equal(o.calls().filter((a) => a[1] === "prompt").length, 0);
  o.advance(3 * MIN); await o.herdr.refresh();
  assert.equal(world.state().agents[0]!.status, "idle");
  await Promise.all([world.react(), world.react()]);
  const prompts = o.calls().filter((a) => a[1] === "prompt");
  assert.equal(prompts.length, 1); assert.match(prompts[0]![3]!, /^2 messages arrived/);
  assert.match(prompts[0]![3]!, /First note[\s\S]*Second note/);
  assert.ok(world.state().messages.every((m) => m.deliveries[0]!.state === "delivered"));
  assert.equal(o.herdr.live()[0]!.status, "working", "the new prompt clears stale evidence immediately");
  await world.react(); assert.equal(o.calls().filter((a) => a[1] === "prompt").length, 1);
});

test("founder wait age is visible after ten minutes and logged once per attempt, never for agent or office messages", () => {
  const message: Message = { id: "m1", kind: "message", toFounder: false, fromAgentId: null, teamId: null, text: "private", images: [], workId: null, createdAt: new Date(0).toISOString(), deliveries: [{ agentId: "a1", state: "queued", error: null, updatedAt: new Date(0).toISOString() }] };
  const delivery = message.deliveries[0]!;
  assert.equal(waitingLabel(message, delivery, 9 * MIN), null);
  assert.equal(waitingLabel(message, delivery, 25 * MIN), "waiting 25 min: they seem busy");
  const logger = new WaitingMessages(), logs: string[] = [];
  logger.check([message], 25 * MIN, (s) => logs.push(s)); logger.check([message], 26 * MIN, (s) => logs.push(s));
  assert.equal(logs.length, 1); assert.match(logs[0]!, /waiting 25 min/); assert.doesNotMatch(logs[0]!, /private/);
  assert.equal(waitingLabel({ ...message, fromAgentId: "crew" }, delivery, 25 * MIN), null);
  assert.equal(waitingLabel({ ...message, fromOffice: true }, delivery, 25 * MIN), null);
  delivery.state = "delivered"; assert.equal(waitingLabel(message, delivery, 25 * MIN), null);
  delivery.state = "queued"; delivery.updatedAt = new Date(26 * MIN).toISOString();
  assert.equal(waitingLabel(message, delivery, 27 * MIN), null);
  logger.check([message], 37 * MIN, (s) => logs.push(s)); assert.equal(logs.length, 2);
});
