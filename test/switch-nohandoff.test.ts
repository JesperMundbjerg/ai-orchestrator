import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { Switches, type SwitchSource } from "../src/server/switch.ts";
import { FACTUAL_NOTICE } from "../src/server/switch-handoff.ts";
import { switchSchema, switchAllSchema } from "../src/shared/agent-protocol.ts";
import type { DatabaseSync } from "node:sqlite";

const TIMING = { pollMs: 5, freeMs: 2000, handoffMs: 2000, quietMs: 60_000 };

/** herdr as the switch sees it: every pane prompted, opened, started and closed, in order. */
function fakeHerdr() {
  let live: LiveAgent[] = [];
  const events: string[] = [];
  const prompts: Array<{ pane: string; text: string }> = [];
  const cwds = new Map<string, string>();
  let panes = 0;
  const hooks: { startAgent?: (pane: string) => Promise<void> | void } = {};
  const source: SwitchSource = {
    available: () => true,
    live: () => live,
    prompt: async (pane, text) => {
      events.push(`prompt ${pane}`);
      prompts.push({ pane, text });
    },
    notify: async () => {},
    createWorktree: async () => ({ paneId: "unused" }),
    startAgent: async (pane, name, harness, args) => {
      events.push(`start ${pane} ${harness} ${name} ${args.join(" ")}`);
      live = [...live, { paneId: pane, harness, sessionId: `session-${pane}`, cwd: cwds.get(pane) ?? null, status: "idle", title: null, name }];
      await hooks.startAgent?.(pane);
    },
    closePane: async (pane) => {
      events.push(`close ${pane}`);
      live = live.filter((a) => a.paneId !== pane);
    },
    removeWorktree: async () => {},
    refresh: async () => {},
    openPane: async (cwd, beside) => {
      const pane = `new${++panes}`;
      cwds.set(pane, cwd);
      events.push(`open ${pane} beside ${beside}`);
      return pane;
    },
    renameAgent: async (pane, name) => {
      events.push(`rename ${pane} ${name}`);
      live = live.map((a) => (a.paneId === pane ? { ...a, name } : a));
    },
  };
  return { source, events, prompts, hooks, setLive: (next: LiveAgent[]) => void (live = next) };
}

/** A Pi agent whose model is unpaid, in a real checkout with an uncommitted change, an open inbox item and a queued message. */
function office(t: TestContext, db: DatabaseSync = openDatabase(":memory:"), h = fakeHerdr(), names = ["einstein"]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "switch-nohandoff-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "lane-einstein", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const transcripts = names.map((n) => {
    const file = join(dir, "pi-sessions", `${n}.jsonl`);
    execFileSync("mkdir", ["-p", join(dir, "pi-sessions")]);
    writeFileSync(file, '{"type":"session"}\n');
    return file;
  });
  const panes = names.map((_, i) => `old${i + 1}`);
  const presence: PresenceSource = {
    available: () => true,
    forSession: (_h, sessionId) => {
      const i = transcripts.indexOf(sessionId);
      return i < 0 ? null : { source: "herdr", paneId: panes[i]!, status: "idle", name: names[i]!, title: null, seenAt: new Date().toISOString() };
    },
    resolvePane: () => null,
  };
  const inbox = new Inbox(db, join(dir, "files"), presence);
  const world = new World(db, h.source, () => inbox.state());
  world.crew = new CrewTreeStore(dir, { piStore: join(dir, "none.json") });
  const switches = new Switches(db, world, h.source, dir, { timing: TIMING, claudeRoot: join(dir, "claude-projects") });
  h.setLive(names.map((n, i): LiveAgent => ({ paneId: panes[i]!, harness: "pi", sessionId: transcripts[i]!, cwd: repo, status: "idle", title: null, name: n })));
  return { db, inbox, world, switches, h, dir, repo, head, transcripts };
}

test("--no-handoff never prompts the old pane: the office writes a factual handoff, the new session is pointed at it, and the old pane closes last", async (t) => {
  const { inbox, world, switches, h, repo, head, transcripts } = office(t);
  const team = await world.createTeam({ name: "Mission Control", standing: true });
  const einstein = world.state().agents.find((a) => a.paneId === "old1")!;
  world.updateAgent(einstein.id, { teamId: team.id, role: "member" });
  inbox.submit({ session: { harness: "pi", sessionId: transcripts[0]!, cwd: repo }, item: { type: "decide", title: "Which footer copy?", request: "Pick one", options: ["A", "B"] } });
  world.messages.tell(einstein.id, { text: "please also fix the footer" });
  assert.equal(world.agent(einstein.id).taskIds.length, 1, "the item is einstein's");
  const role = world.agent(einstein.id).role;

  const started = switches.start(einstein.name, { handoff: false });
  assert.equal(started.to, "claude");
  const done = await switches.settled(started.id);
  assert.equal(done.step, "done", done.says);

  // The old pane was never typed into; the new one only got its brief.
  assert.ok(!h.prompts.some((p) => p.pane === "old1"), "the unpaid session is never prompted");
  assert.deepEqual(h.events.map((e) => e.split(" ").slice(0, 2).join(" ")), ["open new1", "start new1", "close old1", "rename new1", "prompt new1"]);
  assert.match(h.events[1]!, /start new1 claude einstein-claude --model opus/, "the crew guide's Claude half of GPT-6 Astra");

  const file = done.handoff!;
  assert.match(file, new RegExp(`handoffs/switch/${einstein.name.toLowerCase()}-.*\\.md$`));
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(FACTUAL_NOTICE), "it says the old session could not write one");
  assert.ok(text.includes(`Name: ${einstein.name}`));
  assert.match(text, /Team: Mission Control \(standing team\)/);
  assert.ok(text.includes(`Role: ${role}`));
  assert.match(text, /Lane: none/);
  assert.ok(text.includes(`Directory: ${repo}`));
  assert.match(text, /Branch: lane-einstein/);
  assert.ok(text.includes(`HEAD: ${head}`));
  assert.match(text, /M a\.txt/);
  assert.match(text, /\?\? new\.txt/);
  assert.ok(text.includes(transcripts[0]!), "it says where the old transcript is");
  assert.match(text, /\[needs_attention\] decide "Which footer copy\?"/);
  assert.match(text, /\[queued\] message from the founder or the office, .*please also fix the footer/);

  const brief = h.prompts.at(-1)!;
  assert.equal(brief.pane, "new1");
  assert.ok(brief.text.includes(file), "the brief points at the factual handoff");
  assert.match(brief.text, /could not write a handoff.*office wrote a factual one.*last part of the old transcript.*do not redo finished work/);

  const after = world.agent(einstein.id);
  assert.deepEqual([after.name, after.harness, after.teamId, after.role, after.paneId], [einstein.name, "claude", team.id, role, "new1"]);
  // What waited for it reaches the new session after its brief.
  await world.react();
  assert.match(h.prompts.at(-1)!.text, /fix the footer/);
  assert.equal(h.prompts.at(-1)!.pane, "new1");
});

test("--no-handoff with a harness that will not start: the new pane closes, the old one stays, nobody was prompted, the agent is unchanged", async (t) => {
  const { world, switches, h } = office(t);
  const einstein = world.state().agents[0]!;
  h.hooks.startAgent = (pane) => {
    h.setLive(h.source.live().filter((a) => a.paneId !== pane));
    throw new Error("agent did not become ready");
  };
  const failed = await switches.settled(switches.start(einstein.name, { handoff: false }).id);
  assert.equal(failed.step, "failed");
  assert.match(failed.says, new RegExp(`Claude Code did not start .*${einstein.name} is left as it was`));
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.events.map((e) => e.split(" ").slice(0, 2).join(" ")), ["open new1", "start new1", "close new1"]);
  const after = world.agent(einstein.id);
  assert.deepEqual([after.harness, after.paneId], ["pi", "old1"]);
  assert.equal(world.state().agents.length, 1);
});

test("--all-from pi --no-handoff switches each unanswering agent in turn without asking any of them", async (t) => {
  const { world, switches, h } = office(t, undefined, undefined, ["alem", "samir"]);
  const batch = switches.allFrom("pi", { handoff: false });
  assert.equal(batch.switches.length, 2);
  await switches.settled(batch.switches[1]!.id);
  for (const s of batch.switches) {
    const done = switches.get(s.id);
    assert.equal(done.step, "done", done.says);
    assert.ok(readFileSync(done.handoff!, "utf8").includes(FACTUAL_NOTICE));
  }
  assert.ok(h.prompts.every((p) => p.pane.startsWith("new")), "only the new sessions are prompted, with their briefs");
  assert.deepEqual(world.state().agents.map((a) => a.harness), ["claude", "claude"]);
});

test("a restart keeps --no-handoff: the resumed switch still never asks the old session", async (t) => {
  const db = openDatabase(":memory:");
  const h = fakeHerdr();
  const first = office(t, db, h);
  const einstein = first.world.state().agents[0]!;
  let started!: () => void;
  const starting = new Promise<void>((r) => (started = r));
  // The service stops while the new harness is starting: this start never returns.
  h.hooks.startAgent = () => {
    started();
    return new Promise(() => {});
  };
  const s = first.switches.start(einstein.name, { handoff: false });
  await starting;
  assert.equal(first.switches.get(s.id).step, "starting");
  assert.ok(existsSync(first.switches.get(s.id).handoff!));

  h.hooks.startAgent = undefined;
  const second = new Switches(db, first.world, h.source, first.dir, { timing: TIMING });
  await second.resume();
  const done = await second.settled(s.id);
  assert.equal(done.step, "done", done.says);
  assert.ok(!h.prompts.some((p) => p.pane === "old1"));
  assert.match(h.prompts.at(-1)!.text, /office wrote a factual one/);
});

test("an asked handoff that times out says how to switch without one", async (t) => {
  const { db, world, h, dir } = office(t);
  const timed = new Switches(db, world, h.source, dir, { timing: { ...TIMING, handoffMs: 30 } });
  const einstein = world.state().agents[0]!;
  const failed = await timed.settled(timed.start(einstein.name).id);
  assert.equal(failed.step, "failed");
  assert.match(failed.says, /did not write its handoff within .*run the switch again with --no-handoff/);
  assert.deepEqual(h.events, ["prompt old1"]);
  assert.equal(world.agent(einstein.id).harness, "pi");
});

test("the switch request takes handoff: false, and nothing else in its place", () => {
  assert.equal(switchSchema.parse({ agent: "einstein", handoff: false }).handoff, false);
  assert.equal(switchAllSchema.parse({ from: "pi", handoff: false }).handoff, false);
  assert.throws(() => switchSchema.parse({ agent: "einstein", handoff: "no" }));
});
