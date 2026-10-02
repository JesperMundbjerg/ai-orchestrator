import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { Switches, switchChoice, type SwitchSource } from "../src/server/switch.ts";
import type { CrewTree } from "../src/shared/crewtree.ts";
import type { DatabaseSync } from "node:sqlite";

const TIMING = { pollMs: 5, freeMs: 2000, handoffMs: 2000, quietMs: 60_000 };

/** herdr as the switch sees it: panes opened, agents started, prompted, renamed and closed, in order. */
function fakeHerdr() {
  let live: LiveAgent[] = [];
  const events: string[] = [];
  const prompts: Array<{ pane: string; text: string }> = [];
  const cwds = new Map<string, string>();
  let panes = 0;
  const hooks: { onPrompt?: (pane: string, text: string) => Promise<void> | void; startAgent?: (pane: string) => Promise<void> | void; seen?: () => void } = {};
  const source: SwitchSource = {
    available: () => true,
    live: () => live,
    prompt: async (pane, text) => {
      events.push(`prompt ${pane}`);
      prompts.push({ pane, text });
      await hooks.onPrompt?.(pane, text);
    },
    notify: async () => {},
    createWorktree: async () => ({ paneId: "unused" }),
    startAgent: async (pane, name, harness, args) => {
      events.push(`start ${pane} ${harness} ${name} ${args.join(" ")}`);
      live = [...live, { paneId: pane, harness, sessionId: `session-${pane}`, cwd: cwds.get(pane) ?? null, status: "idle", title: null, name }];
      hooks.seen?.();
      await hooks.startAgent?.(pane);
    },
    closePane: async (pane) => {
      events.push(`close ${pane}`);
      hooks.seen?.();
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
  return {
    source, events, prompts, hooks, cwds,
    setLive: (next: LiveAgent[]) => void (live = next),
    setStatus: (pane: string, status: LiveAgent["status"]) => void (live = live.map((a) => (a.paneId === pane ? { ...a, status } : a))),
  };
}

function office(db: DatabaseSync = openDatabase(":memory:"), herdr = fakeHerdr(), mode = "mixed", timing: Partial<typeof TIMING> = {}, scheduler: { now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "switch-test-"));
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(dir, "files"), presence, scheduler.now);
  const world = new World(db, herdr.source, () => inbox.state(), scheduler.now);
  world.crew = new CrewTreeStore(dir, { piStore: join(dir, "none.json") });
  if (mode !== "mixed") world.crew.save({ ...world.crew.state().tree, mode } satisfies CrewTree);
  const switches = new Switches(db, world, herdr.source, dir, { timing: { ...TIMING, ...timing }, ...scheduler });
  return { db, world, switches, herdr, dir };
}

const agent = (paneId: string, cwd: string, harness: LiveAgent["harness"], name: string | null, status: LiveAgent["status"] = "idle"): LiveAgent =>
  ({ paneId, harness, sessionId: `session-${paneId}`, cwd, status, title: null, name });

/** The agent writes its handoff when asked, as a real one would. */
function writesHandoff(h: ReturnType<typeof fakeHerdr>) {
  h.hooks.onPrompt = (_pane, text) => {
    const file = text.match(/handoff for it now to (\S+\.md)/)?.[1];
    if (file) writeFileSync(file, "# Handoff\nState: halfway.\n");
  };
}

/** A standing team of the agents in two panes; the first leads it. */
async function team(world: World, lead: string, member: string) {
  const t = await world.createTeam({ name: "Mission Control", standing: true });
  const [l, m] = [world.state().agents.find((a) => a.paneId === lead)!, world.state().agents.find((a) => a.paneId === member)!];
  world.updateAgent(l.id, { teamId: t.id, role: "lead" });
  world.updateAgent(m.id, { teamId: t.id, role: "member" });
  return { team: t, lead: world.agent(l.id), member: world.agent(m.id) };
}

test("the crew tree's pairs decide the model across: Opus and GPT-6 Astra, Sonnet and GPT-6.1 Sol", () => {
  const tree = JSON.parse(readFileSync(new URL("../src/server/crewtree.default.json", import.meta.url), "utf8")) as CrewTree;
  assert.deepEqual(switchChoice(tree, { harness: "claude", model: "claude-opus-5-5", lead: false }, "pi"), { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "high" });
  assert.deepEqual(switchChoice(tree, { harness: "claude", model: "claude-sonnet-5-5", lead: false }, "pi"), { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" });
  assert.deepEqual(switchChoice(tree, { harness: "pi", model: "openai-codex/gpt-6-astra", lead: false }, "claude"), { harness: "claude", model: "opus", effort: "medium" });
  assert.deepEqual(switchChoice(tree, { harness: "pi", model: "gpt-6.1-sol", lead: false }, "claude"), { harness: "claude", model: "sonnet", effort: "high" });
  // Unknown model: a lead takes the lead's pair, anyone else the fallback's.
  assert.equal(switchChoice(tree, { harness: "claude", model: null, lead: true }, "pi").model, "openai-codex/gpt-6-astra");
  assert.equal(switchChoice(tree, { harness: "claude", model: null, lead: false }, "pi").model, "openai-codex/gpt-6.1-sol");
});

test("a running agent writes its handoff, the new harness takes over its name, team, role and messages, and its old pane closes last", async () => {
  const h = fakeHerdr();
  const { db, world, switches } = office(undefined, h);
  h.setLive([agent("lead1", "/repo", "claude", "clara"), agent("old1", "/repo", "claude", "kestrel", "working")]);
  const { lead, member } = await team(world, "lead1", "old1");
  // Both share a checkout; the member is the one herdr knows as kestrel.
  const kestrel = world.state().agents.find((a) => a.paneId === "old1")!;
  assert.equal(kestrel.id, member.id);
  world.messages.tell(kestrel.id, { text: "please also fix the footer" });
  writesHandoff(h);
  // Nobody new ever shows up in the office while it happens.
  h.hooks.seen = () => assert.deepEqual(world.state().agents.map((a) => a.name).sort(), [lead.name, kestrel.name].sort());

  const started = switches.start(kestrel.name);
  assert.equal(started.to, "pi");
  assert.equal(started.step, "waiting");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.prompts.length, 0, "a busy agent is waited for, not interrupted");
  await world.react();
  assert.equal(h.prompts.length, 0, "what waits for it is held while it is being switched");
  h.setStatus("old1", "idle");
  const done = await switches.settled(started.id);
  assert.equal(done.step, "done", done.says);

  const after = world.agent(kestrel.id);
  assert.equal(after.name, kestrel.name);
  assert.equal(after.teamId, kestrel.teamId);
  assert.equal(after.role, "member");
  assert.equal(after.harness, "pi");
  assert.equal(after.paneId, "new1");
  assert.equal(world.state().agents.length, 2);
  assert.equal(world.agent(lead.id).role, "lead");

  const order = h.events.map((e) => e.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(order, ["prompt old1", "open new1", "start new1", "close old1", "rename new1", "prompt new1"]);
  assert.match(h.events[1]!, /beside old1/);
  assert.match(h.events[2]!, /start new1 pi kestrel-pi --model openai-codex\/gpt-6\.1-sol:high/);
  assert.match(h.events[4]!, /rename new1 kestrel$/, "the new session goes by the old herdr name");
  const handoff = done.handoff!;
  assert.match(handoff, new RegExp(`handoffs/switch/${kestrel.name.toLowerCase()}-[0-9T-]+Z-[a-f0-9]{8}\\.md$`));
  assert.match(h.prompts[1]!.text, new RegExp(`You are ${kestrel.name}.*read the handoff it wrote for you: ${handoff.replaceAll(".", "\\.")}`));

  // The message queued for it went to nobody during the switch, and reaches the new session after its brief.
  await world.react();
  assert.equal(h.prompts.length, 3);
  assert.equal(h.prompts[2]!.pane, "new1");
  assert.match(h.prompts[2]!.text, /fix the footer/);

  // A restart reads the same office: the record is the new session's.
  const again = new World(db, h.source, () => ({ tasks: [], projects: [], items: [] }));
  assert.deepEqual(again.state().agents.map((a) => [a.name, a.harness, a.role]).sort(), world.state().agents.map((a) => [a.name, a.harness, a.role]).sort());
});

test("an offline agent skips the handoff and starts beside its lead", async () => {
  const h = fakeHerdr();
  const { world, switches } = office(undefined, h);
  h.setLive([agent("lead1", "/lead", "pi", null), agent("p2", "/member", "pi", null)]);
  const { member } = await team(world, "lead1", "p2");
  h.setLive([agent("lead1", "/lead", "pi", null)]);
  assert.equal(world.agent(member.id).status, "offline");
  const done = await switches.settled(switches.start(member.id, { to: "claude" }).id);
  assert.equal(done.step, "done", done.says);
  assert.equal(done.handoff, null);
  assert.deepEqual(h.events.map((e) => e.split(" ").slice(0, 2).join(" ")), ["open new1", "start new1", "prompt new1"]);
  assert.match(h.events[0]!, /beside lead1/);
  assert.match(h.events[1]!, /--model sonnet --effort high/);
  assert.match(h.prompts[0]!.text, /there is no handoff/);
  const after = world.agent(member.id);
  assert.deepEqual([after.name, after.harness, after.teamId, after.paneId], [member.name, "claude", member.teamId, "new1"]);
});

test("no handoff in time, or a harness that will not start: the agent is left as it was", async () => {
  const h = fakeHerdr();
  const { world, switches } = office(undefined, h, "mixed", { handoffMs: 40 });
  h.setLive([agent("old1", "/a", "claude", "wren")]);
  const wren = world.state().agents[0]!;
  const timedOut = await switches.settled(switches.start(wren.name).id);
  assert.equal(timedOut.step, "failed");
  assert.match(timedOut.says, new RegExp(`did not write its handoff within .*${wren.name} is left as it was`));
  assert.deepEqual(h.events, ["prompt old1"]);
  assert.equal(world.agent(wren.id).harness, "claude");
  assert.equal(world.agent(wren.id).paneId, "old1");

  // Now it writes one, but the new harness never runs: the new pane is closed, the old one is not.
  writesHandoff(h);
  h.hooks.startAgent = (pane) => {
    h.setLive(h.source.live().filter((a) => a.paneId !== pane));
    throw new Error("agent did not become ready");
  };
  h.events.length = 0;
  const failed = await switches.settled(switches.start(wren.name).id);
  assert.equal(failed.step, "failed");
  assert.match(failed.says, /Pi did not start \(herdr: agent did not become ready\)/);
  assert.deepEqual(h.events.map((e) => e.split(" ").slice(0, 2).join(" ")), ["prompt old1", "open new1", "start new1", "close new1"]);
  assert.equal(world.agent(wren.id).paneId, "old1");
  assert.equal(world.state().agents.length, 1);
});

test("the founder's switch: nobody is switched into a harness that is switched off", () => {
  const h = fakeHerdr();
  const { world, switches } = office(undefined, h, "claude");
  h.setLive([agent("c1", "/a", "claude", "wren"), agent("p1", "/b", "pi", "ibis")]);
  const [wren, ibis] = ["c1", "p1"].map((pane) => world.state().agents.find((a) => a.paneId === pane)!);
  assert.throws(() => switches.start(wren!.name), /switched Pi off/);
  const offers = world.state().switches!.offers;
  assert.match(offers[wren!.id]!.refused!, /switched Pi off/);
  assert.equal(offers[ibis!.id]!.refused, null);
  assert.equal(offers[ibis!.id]!.label, "Claude Code");
  assert.throws(() => switches.start(ibis!.name, { to: "pi" }), /already runs on Pi/);
});

test("--all-from switches everyone on a harness one by one", async () => {
  const h = fakeHerdr();
  const { world, switches } = office(undefined, h);
  h.setLive([agent("p1", "/a", "pi", "ibis"), agent("p2", "/b", "pi", "finch"), agent("c1", "/c", "claude", "wren")]);
  writesHandoff(h);
  const batch = switches.allFrom("pi");
  assert.equal(batch.switches.length, 2);
  assert.deepEqual(batch.switches.map((s) => s.step), ["waiting", "queued"]);
  await switches.settled(batch.switches[1]!.id);
  for (const s of batch.switches) assert.equal(switches.get(s.id).step, "done", switches.get(s.id).says);
  const order = h.events.map((e) => e.split(" ").slice(0, 2).join(" "));
  const old = order.filter((e) => e.startsWith("close")).map((e) => e.split(" ")[1]);
  assert.deepEqual(order, [
    `prompt ${old[0]}`, "open new1", "start new1", `close ${old[0]}`, "rename new1", "prompt new1",
    `prompt ${old[1]}`, "open new2", "start new2", `close ${old[1]}`, "rename new2", "prompt new2",
  ]);
  assert.deepEqual([...old].sort(), ["p1", "p2"]);
  assert.deepEqual(world.state().agents.map((a) => a.harness).sort(), ["claude", "claude", "claude"]);
  assert.throws(() => switches.allFrom("pi"), /nobody is running on Pi/);
});

test("a restart mid-switch picks it up where it was, and the new session never shows as a stranger", async () => {
  const db = openDatabase(":memory:");
  const h = fakeHerdr();
  const first = office(db, h);
  h.setLive([agent("old1", "/a", "claude", "wren")]);
  const wren = first.world.state().agents[0]!;
  writesHandoff(h);
  let started!: () => void;
  const starting = new Promise<void>((r) => (started = r));
  // The service stops while the new harness is starting: this start never returns.
  h.hooks.startAgent = () => {
    started();
    return new Promise(() => {});
  };
  const s = first.switches.start(wren.name);
  await starting;
  assert.equal(first.switches.get(s.id).step, "starting");
  assert.deepEqual(first.world.state().agents.map((a) => a.paneId), ["old1"]);

  h.hooks.startAgent = undefined;
  const second = office(db, h);
  assert.deepEqual(second.world.state().agents.map((a) => a.paneId), ["old1"], "the new pane stays hidden after the restart");
  await second.switches.resume();
  const done = await second.switches.settled(s.id);
  assert.equal(done.step, "done", done.says);
  const after = second.world.agent(wren.id);
  assert.deepEqual([after.name, after.harness, after.paneId], [wren.name, "pi", "new1"]);
  assert.equal(second.world.state().agents.length, 1);
});

test("a project's lead switched: still its lead, and no new project is made for the new session", async () => {
  const h = fakeHerdr();
  const { db, world, switches } = office(undefined, h);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "switch-repo-")));
  const root = join(dir, "repo");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  h.source.createWorktree = async (repoRoot, place) => {
    git(repoRoot, "worktree", "add", "-q", "-b", place.branch, place.path);
    h.cwds.set("w1", place.path);
    return { paneId: "w1" };
  };
  const project = await world.createTeam({ name: "Atoms", repository: root });
  const lead = world.state().agents.find((a) => a.paneId === "w1")!;
  assert.equal(lead.role, "lead");
  assert.equal(lead.teamId, project.id);
  writesHandoff(h);
  h.events.length = 0;
  const done = await switches.settled(switches.start(lead.name).id);
  assert.equal(done.step, "done", done.says);
  assert.match(h.events[2]!, /--model openai-codex\/gpt-6-astra:high/, "a lead's model comes from the crew tree's lead pair");
  const state = world.state();
  assert.deepEqual(state.teams.map((t) => t.name), ["Atoms"]);
  const after = world.agent(lead.id);
  assert.deepEqual([after.name, after.role, after.teamId, after.harness], [lead.name, "lead", project.id, "pi"]);
  assert.equal((db.prepare("SELECT lead_pane FROM teams WHERE id = ?").get(project.id) as { lead_pane: string }).lead_pane, after.paneId);
  assert.match(h.prompts.at(-1)!.text, /you lead your project/);
});
