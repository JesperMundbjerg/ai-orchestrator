import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { Switches, type SwitchSource } from "../src/server/switch.ts";
import { AgentStartingError } from "../src/server/agent-starting.ts";

function provider() {
  let live: LiveAgent[] = [{ paneId: "old", harness: "claude", sessionId: "old-session", cwd: "/scratch/switch-checkout", status: "idle", title: null, name: "wren" }];
  const events: Array<{ effect: string; pane: string; text?: string }> = [];
  let opened = 0;
  const source: SwitchSource = {
    available: () => true, live: () => live, refresh: async () => {}, notify: async () => {},
    createWorktree: async () => { throw new Error("not used"); }, removeWorktree: async () => {},
    prompt: async (pane, text) => {
      events.push({ effect: pane === "old" ? "handoff" : "briefing", pane, text });
      const path = text.match(/handoff for it now to (\S+\.md)/)?.[1];
      if (path) writeFileSync(path, "# Handoff\nContinue here.\n");
    },
    openPane: async (_cwd, _beside, label) => {
      const pane = `new${++opened}`;
      events.push({ effect: "opening", pane, text: label });
      return pane;
    },
    startAgent: async (paneId, name, harness) => {
      events.push({ effect: "starting", pane: paneId });
      live = [...live, { paneId, harness, sessionId: `session-${paneId}`, cwd: "/scratch/switch-checkout", status: "idle", title: null, name }];
    },
    closePane: async (pane) => { events.push({ effect: "closing", pane }); live = live.filter((l) => l.paneId !== pane); },
    renameAgent: async (pane, name) => { live = live.map((l) => l.paneId === pane ? { ...l, name } : l); },
  };
  return { source, events, status: (pane: string, status: LiveAgent["status"]) => { live = live.map((l) => l.paneId === pane ? { ...l, status } : l); } };
}

function office(db: DatabaseSync, source: SwitchSource, dir: string, clock: { t: number }, sleep: (ms: number) => Promise<void>) {
  const now = () => new Date(clock.t);
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null }, now);
  const world = new World(db, source, () => inbox.state(), now);
  const switches = new Switches(db, world, source, dir, { now, sleep, timing: { pollMs: 5, handoffMs: 20, freeMs: 50, quietMs: 30_000 } });
  return { world, switches };
}

for (const effect of ["handoff", "opening", "starting", "closing", "briefing"] as const) {
  for (const phase of ["before", "after"] as const) {
    test(`close/reopen after checkpoint ${phase} ${effect}: no unsafe effect replay`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "switch-boundary-"));
      const file = join(dir, "inbox.db");
      let db = openDatabase(file);
      const h = provider();
      const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
      const sleep = async (ms: number) => { clock.t += ms; };
      const first = office(db, h.source, dir, clock, sleep);
      const agent = first.world.state().agents[0]!;
      const waiting = first.world.messages.tell(agent.id, { text: "Ordinary work must follow the brief" });
      let signal!: () => void;
      const reached = new Promise<void>((r) => { signal = r; });
      const interrupt = async <T>(perform: () => Promise<T>): Promise<T> => {
        const row = db.prepare("SELECT * FROM agent_switches").get()!;
        assert.equal(row.effect, effect, "intent is durable before dispatch");
        if (effect === "handoff") assert.ok(row.handoff, "the deterministic address precedes the prompt");
        if (effect === "starting" || effect === "briefing") assert.ok(row.new_pane);
        if (phase === "after") await perform();
        signal();
        return new Promise<T>(() => {}); // The first process stops here and never records the result.
      };
      const originals = { prompt: h.source.prompt, openPane: h.source.openPane, startAgent: h.source.startAgent, closePane: h.source.closePane };
      if (effect === "handoff" || effect === "briefing") h.source.prompt = (pane, text) => (pane === "old") === (effect === "handoff") ? interrupt(() => originals.prompt(pane, text)) : originals.prompt(pane, text);
      if (effect === "opening") h.source.openPane = (...args) => interrupt(() => originals.openPane(...args));
      if (effect === "starting") h.source.startAgent = (...args) => interrupt(() => originals.startAgent(...args));
      if (effect === "closing") h.source.closePane = (...args) => interrupt(() => originals.closePane(...args));
      try {
        const started = first.switches.start(agent.id);
        await reached;
        assert.ok(first.world.messages.held().has(agent.id));
        Object.assign(h.source, originals);
        db.close();
        db = openDatabase(file);
        const second = office(db, h.source, dir, clock, sleep);
        await second.switches.resume();
        const result = await second.switches.settled(started.id);
        const paused = effect === "opening" || effect === "briefing" || (effect === "starting" && phase === "before");
        if (paused) {
          assert.match(result.says, /Recovery required/);
          assert.ok(result.error);
          assert.ok(second.world.messages.held().has(agent.id));
          await second.world.messages.deliver(second.world.state());
          assert.equal(second.world.messages.message(waiting.id).deliveries[0]!.state, "queued");
          const count = h.events.length;
          await second.switches.resume();
          await second.switches.settled(started.id);
          assert.equal(h.events.length, count, "a further restart/resume does not retry an unknown effect");
        } else if (effect === "handoff" && phase === "before") {
          assert.equal(result.step, "failed");
          assert.equal(h.events.length, 0, "an interrupted handoff prompt is never repeated");
          assert.equal(second.world.agent(agent.id).paneId, "old");
        } else {
          assert.equal(result.step, "done", result.says);
          assert.equal(second.world.agent(agent.id).paneId, "new1");
          await second.world.messages.deliver(second.world.state());
          assert.equal(second.world.messages.message(waiting.id).deliveries[0]!.state, "delivered");
          assert.match(h.events.at(-1)!.text!, /Ordinary work must follow the brief/);
        }
        const actual = h.events.filter((e) => e.effect === effect && (effect !== "briefing" || !e.text?.includes("Ordinary work")));
        assert.equal(actual.length, effect === "closing" ? 1 : phase === "after" ? 1 : 0, "non-idempotent effects are not automatically duplicated");
        if (effect === "opening" && phase === "after") assert.match(actual[0]!.text!, new RegExp(`switch:${started.id}:opening`));
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

for (const checkpoint of ["handoff", "opening-result", "brief-result"] as const) {
  test(`a failed ${checkpoint} checkpoint never grants permission to repeat its effect`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "switch-checkpoint-"));
    const file = join(dir, "inbox.db");
    let db = openDatabase(file);
    const h = provider();
    const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
    const f = office(db, h.source, dir, clock, async (ms) => { clock.t += ms; });
    const condition = checkpoint === "handoff" ? "NEW.effect = 'handoff'"
      : checkpoint === "opening-result" ? "NEW.step = 'starting' AND OLD.effect = 'opening'"
      : "NEW.step = 'done' AND OLD.effect = 'briefing'";
    db.exec(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON agent_switches WHEN ${condition}
      BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`);
    try {
      const agent = f.world.state().agents[0]!;
      const started = f.switches.start(agent.id);
      const result = await f.switches.settled(started.id);
      if (checkpoint === "handoff") {
        assert.equal(result.step, "failed");
        assert.equal(h.events.length, 0, "a failed intent checkpoint dispatches nothing");
      } else {
        assert.match(result.says, /Recovery required/);
        assert.ok(f.world.messages.held().has(agent.id));
        const effect = checkpoint === "opening-result" ? "opening" : "briefing";
        assert.equal(h.events.filter((e) => e.effect === effect).length, 1);
        db.close();
        db = openDatabase(file);
        const again = office(db, h.source, dir, clock, async () => {});
        await again.switches.resume();
        await again.switches.settled(started.id);
        assert.equal(h.events.filter((e) => e.effect === effect).length, 1);
      }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("rollback records cleanup before closing the replacement, and resumes exact-resource cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switch-cleanup-"));
  const file = join(dir, "inbox.db");
  let db = openDatabase(file);
  const h = provider();
  const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
  const first = office(db, h.source, dir, clock, async () => {});
  const agent = first.world.state().agents[0]!;
  h.source.startAgent = async () => { throw new Error("launch refused"); };
  const close = h.source.closePane;
  let entered!: () => void;
  const cleaning = new Promise<void>((r) => { entered = r; });
  h.source.closePane = async (pane) => {
    assert.equal(pane, "new1");
    assert.equal(db.prepare("SELECT effect FROM agent_switches").get()!.effect, "cleanup");
    entered();
    await new Promise<void>(() => {});
  };
  try {
    const started = first.switches.start(agent.id);
    await cleaning;
    assert.ok(first.world.messages.held().has(agent.id));
    assert.throws(() => first.switches.start(agent.id), /already being switched/);
    db.close();
    db = openDatabase(file);
    h.source.closePane = close;
    const second = office(db, h.source, dir, clock, async () => {});
    await second.switches.resume();
    const done = await second.switches.settled(started.id);
    assert.equal(done.step, "failed");
    assert.equal(db.prepare("SELECT effect FROM agent_switches").get()!.effect, null);
    assert.equal(second.world.agent(agent.id).paneId, "old");
    assert.equal(second.world.messages.held().size, 0);
    assert.deepEqual(h.events.filter((e) => e.effect === "closing").map((e) => e.pane), ["new1"]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a brief queued at a trust prompt keeps older messages held until its acknowledged prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switch-brief-wait-"));
  const file = join(dir, "inbox.db");
  let db = openDatabase(file);
  const h = provider();
  const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
  let reached!: () => void;
  const waitingForFree = new Promise<void>((r) => { reached = r; });
  const originalStart = h.source.startAgent;
  h.source.startAgent = async (...args) => { await originalStart(...args); h.status(args[0], "blocked"); };
  const originalSleep = async () => { reached(); await new Promise<void>(() => {}); };
  const first = office(db, h.source, dir, clock, originalSleep);
  const agent = first.world.state().agents[0]!;
  const message = first.world.messages.tell(agent.id, { text: "An older instruction" });
  try {
    const started = first.switches.start(agent.id);
    await waitingForFree;
    assert.equal(first.switches.get(started.id).step, "briefing");
    assert.equal(db.prepare("SELECT brief_state FROM agent_switches").get()!.brief_state, "queued");
    assert.equal(first.world.messages.list().length, 1, "the brief is not queued as an ordinary message");
    await first.world.messages.deliver(first.world.state());
    assert.equal(h.events.filter((e) => e.effect === "briefing").length, 0);
    db.close();
    db = openDatabase(file);
    h.status("new1", "idle");
    const second = office(db, h.source, dir, clock, async () => {});
    await second.switches.resume();
    assert.equal((await second.switches.settled(started.id)).step, "done");
    assert.equal(db.prepare("SELECT brief_state FROM agent_switches").get()!.brief_state, "delivered");
    assert.equal(second.world.messages.message(message.id).deliveries[0]!.state, "queued");
    assert.match(h.events.at(-1)!.text!, /First read the handoff/);
    await second.world.messages.deliver(second.world.state());
    assert.match(h.events.at(-1)!.text!, /An older instruction/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("only a definite pre-submission refusal requeues the prerequisite brief", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switch-brief-refusal-"));
  const db = openDatabase(":memory:");
  const h = provider();
  const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
  const original = h.source.prompt;
  let refused = false;
  h.source.prompt = async (pane, text) => {
    if (pane !== "old" && !refused) { refused = true; throw new AgentStartingError("agent is not active yet"); }
    await original(pane, text);
  };
  const f = office(db, h.source, dir, clock, async (ms) => {
    clock.t += ms;
    assert.equal(db.prepare("SELECT brief_state FROM agent_switches").get()!.brief_state, "queued");
    assert.equal(f.world.messages.held().size, 1);
  });
  try {
    const agent = f.world.state().agents[0]!;
    const result = await f.switches.settled(f.switches.start(agent.id).id);
    assert.equal(result.step, "done", result.says);
    assert.equal(h.events.filter((e) => e.effect === "briefing").length, 1);
    assert.equal(f.world.messages.held().size, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
