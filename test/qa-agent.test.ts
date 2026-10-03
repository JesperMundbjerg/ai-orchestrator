import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, InboxError, type PresenceSource } from "../src/server/inbox.ts";
import { AutoApprove } from "../src/server/autoapprove.ts";
import { QaAgents, type QaAgentSource } from "../src/server/qa-agent.ts";
import { agentId, liveIdentity, type LiveAgent } from "../src/server/world.ts";
import type { CrewCatalog } from "../src/shared/crewtree.ts";
import type { Harness, SessionInput } from "../src/shared/types.ts";

const presence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };
const catalog: CrewCatalog = { harnesses: [
  { id: "claude", label: "Claude Code", models: [{ id: "opus", label: "Opus 5.5" }, { id: "haiku", label: "Haiku 4.5" }], efforts: ["low", "medium"] },
  { id: "pi", label: "Pi", models: [{ id: "openai-codex/gpt-6.1-sol", label: "GPT-6.1 Sol" }], efforts: ["high"] },
] };
const opus = { harness: "claude", model: "opus", effort: "medium" };
const sol = { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" };
const haiku = { harness: "claude", model: "haiku", effort: "low" };

/** herdr as the office sees it: panes, the agents started in them, and what was closed. Nothing really starts. */
function fakeHerdr() {
  const panes = new Map<string, LiveAgent | null>();
  const started: Array<{ paneId: string; name: string; harness: Harness; args: string[] }> = [];
  const closed: string[] = [];
  let n = 0;
  const source: QaAgentSource & { failModel: string | null } = {
    failModel: null,
    available: () => true,
    live: () => [...panes.values()].filter((a): a is LiveAgent => a !== null),
    openPane: async (cwd) => { const id = `p${++n}`; panes.set(id, null); assert.equal(cwd, "/office"); return id; },
    startAgent: async (paneId, name, harness, args) => {
      if (args.includes(source.failModel!)) throw new Error("agent did not become ready");
      started.push({ paneId, name, harness, args });
      panes.set(paneId, { paneId, harness, sessionId: null, cwd: "/office", status: "idle", title: null, name });
    },
    closePane: async (paneId) => { closed.push(paneId); panes.delete(paneId); },
  };
  return { source, panes, started, closed };
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "qa-agent-"));
  const db = openDatabase(join(dir, "inbox.sqlite"));
  const inbox = new Inbox(db, join(dir, "files"), presence);
  const auto = new AutoApprove(db, inbox, join(dir, "learnings"));
  const herdr = fakeHerdr();
  // Quinn is an agent the founder had chosen before; the office did not start it.
  const quinn = { id: "quinn", name: "Quinn", online: true, taskIds: [] };
  const live = () => herdr.source.live().map((a) => ({ id: agentId(liveIdentity(a)), name: a.name!, online: true, taskIds: [] }));
  auto.qa.office = {
    agent: (id) => (id === quinn.id ? quinn : live().find((a) => a.id === id) ?? null),
    resolve: (_s: SessionInput) => { throw new InboxError(404, "unknown"); },
    notice: () => {},
  };
  auto.agents = new QaAgents(db, herdr.source, { catalog: () => catalog, learnings: join(dir, "learnings"), cwd: "/office" });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const settle = async () => { await auto.startup; };
  return { auto, herdr, quinn, settle };
}

test("picking a model starts a QA agent on it and designates it once it runs", async (t) => {
  const { auto, herdr, settle } = setup(t);
  assert.deepEqual(auto.state().qaModels.map((m) => m.label), [
    "Opus 5.5 · low (Claude Code)", "Opus 5.5 · medium (Claude Code)", "Haiku 4.5 · low (Claude Code)", "Haiku 4.5 · medium (Claude Code)", "GPT-6.1 Sol · high (Pi)",
  ]);
  // QA answers need their agent: the setting waits, and the header says it is starting.
  const starting = auto.setMode("qa", undefined, opus);
  assert.equal(starting.mode, "off");
  assert.equal(starting.qaAgent?.status, "starting");
  assert.equal(starting.qaAgent?.mode, "qa");
  assert.equal(starting.qa, null, "nothing is designated while it starts");
  await settle();

  const [start] = herdr.started;
  assert.ok(start);
  assert.match(start.name, /^qa-opus-[0-9a-f]{4}$/);
  assert.equal(start.harness, "claude");
  assert.deepEqual(start.args.slice(0, 4), ["--model", "opus", "--effort", "medium"]);
  const brief = start.args[start.args.indexOf("--append-system-prompt") + 1]!;
  assert.match(brief, /started you as its QA agent, on Opus 5\.5 · medium \(Claude Code\)/);
  assert.match(brief, /inbox qa next/);
  assert.ok(brief.includes(join("learnings")), "the brief says where the learnings are");

  const state = auto.state();
  assert.equal(state.mode, "qa");
  assert.equal(state.qaAgent?.status, "online");
  assert.equal(state.qaAgent?.model.label, "Opus 5.5 · medium (Claude Code)");
  assert.equal(state.qa?.agentId, state.qaAgent?.agentId);
  assert.equal(state.qa?.agentName, start.name);

  // A spawned agent that dies stays designated, shown offline: everything is the founder's again.
  herdr.panes.delete(start.paneId);
  assert.equal(auto.state().qaAgent?.status, "offline");
  assert.equal(auto.state().qa?.agentId, state.qaAgent?.agentId);
  assert.equal(auto.state().qa?.online, false);
});

test("another model replaces the QA agent, closing only an agent the office started", async (t) => {
  const { auto, herdr, quinn, settle } = setup(t);
  auto.setMode("off", quinn.id);
  auto.setMode("off", undefined, sol);
  await settle();
  const first = herdr.started[0]!;
  assert.deepEqual(first.args.slice(0, 2), ["--model", "openai-codex/gpt-6.1-sol:high"]);
  assert.equal(first.harness, "pi");
  assert.notEqual(auto.state().qa?.agentId, quinn.id);
  assert.deepEqual(herdr.closed, [], "Quinn was chosen, not started, by the office: never closed");

  // While one starts, the choice cannot change underneath it.
  auto.setMode("off", undefined, opus);
  assert.throws(() => auto.setMode("off", undefined, haiku), /is starting/);
  await settle();
  const second = herdr.started[1]!;
  assert.deepEqual(herdr.closed, [first.paneId], "the office closes the QA agent it started");
  const state = auto.state();
  assert.equal(state.mode, "off");
  assert.equal(state.qaAgent?.model.label, "Opus 5.5 · medium (Claude Code)");
  assert.equal(state.qa?.agentName, second.name);

  // Designating the same agent again keeps it running.
  auto.setMode("off", state.qa!.agentId);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(herdr.closed, [first.paneId]);
  assert.equal(auto.state().qaAgent?.status, "online");

  // Designating an agent the office did not start replaces the started one too, and that agent is never closed later.
  auto.setMode("off", quinn.id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(herdr.closed, [first.paneId, second.paneId]);
  assert.equal(auto.state().qaAgent, null);
  auto.setMode("off", null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(herdr.closed, [first.paneId, second.paneId]);
});

test("none clears the QA agent and closes the one the office started; QA answers still need one", async (t) => {
  const { auto, herdr, settle } = setup(t);
  auto.setMode("qa", undefined, opus);
  await settle();
  const started = herdr.started[0]!;
  assert.throws(() => auto.setMode("qa", undefined, null), /choose the model/);
  assert.equal(auto.state().qa?.agentName, started.name);

  const none = auto.setMode("off", undefined, null);
  assert.equal(none.qa, null);
  assert.equal(none.qaAgent, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(herdr.closed, [started.paneId]);
  assert.throws(() => auto.setMode("qa"), /choose the model/);
});

test("a start that fails designates nothing, closes its pane and says why", async (t) => {
  const { auto, herdr, quinn, settle } = setup(t);
  herdr.source.failModel = "haiku";
  auto.setMode("qa", undefined, haiku);
  await settle();
  let state = auto.state();
  assert.equal(state.mode, "off", "QA answers stay off without their agent");
  assert.equal(state.qa, null);
  assert.equal(state.qaAgent, null);
  assert.match(state.qaError ?? "", /the QA agent on Haiku 4\.5 · low \(Claude Code\) did not start \(herdr: agent did not become ready\)/);
  assert.deepEqual(herdr.closed, ["p1"], "its empty pane is closed again");

  // A failed replacement leaves the QA agent there was.
  auto.setMode("off", quinn.id);
  auto.setMode("off", undefined, haiku);
  await settle();
  state = auto.state();
  assert.equal(state.qa?.agentId, quinn.id);
  assert.ok(state.qaError);
  // Without herdr nothing starts either; the next choice clears the error.
  herdr.source.available = () => false;
  auto.setMode("off", undefined, opus);
  await settle();
  assert.match(auto.state().qaError ?? "", /herdr is not running/);
  assert.equal(auto.state().qa?.agentId, quinn.id);
  assert.equal(auto.setMode("off", null).qaError, null);
});

test("only the crew catalog's models can be started", (t) => {
  const { auto, herdr } = setup(t);
  assert.throws(() => auto.setMode("off", undefined, { harness: "claude", model: "opus", effort: "max" }), /not in the crew catalog/);
  assert.throws(() => auto.setMode("off", undefined, { harness: "codex", model: "gpt", effort: "high" }), /not in the crew catalog/);
  assert.equal(herdr.started.length, 0);
});
