import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHookEvents, describeTool } from "../src/server/activity.ts";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { checkoutsIn, placeFor } from "../src/server/worktrees.ts";

function setup(now?: () => Date) {
  const db = openDatabase(":memory:");
  let live: LiveAgent[] = [];
  // Presence the way herdr gives it: a task's session found running in a pane.
  const presence: PresenceSource = {
    available: () => true,
    forSession: (harness, sessionId) => {
      const a = live.find((x) => x.harness === harness && x.sessionId === sessionId);
      return a ? { source: "herdr", paneId: a.paneId, status: a.status, name: null, title: null, seenAt: "" } : null;
    },
    resolvePane: () => null,
  };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "world-test-")), "files"), presence);
  const prompts: Array<{ pane: string; text: string }> = [];
  const notices: string[] = [];
  const started: Array<{ pane: string; name: string; harness: string; args: string[] }> = [];
  const closed: string[] = [];
  let refuse: string | null = null;
  let startFails: string | null = null;
  let onStart: (() => void) | null = null;
  // herdr's worktree commands, done with git the way herdr does them.
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    prompt: async (pane, text) => {
      if (refuse) throw new Error(refuse);
      prompts.push({ pane, text });
    },
    notify: async (title) => void notices.push(title),
    createWorktree: async (repoRoot, place) => {
      git(repoRoot, "worktree", "add", "-b", place.branch, place.path, ...(place.base ? [place.base] : []));
      return { paneId: "w2:p1" };
    },
    startAgent: async (pane, name, harness, args) => {
      started.push({ pane, name, harness, args });
      onStart?.();
      if (startFails) throw new Error(startFails);
    },
    closePane: async (pane) => void closed.push(pane),
    removeWorktree: async (repoRoot, path) => void git(repoRoot, "worktree", "remove", path),
  };
  const world = new World(db, source, () => inbox.state(), now);
  return { db, inbox, world, prompts, notices, started, closed, setLive: (next: LiveAgent[]) => void (live = next), refuse: (why: string | null) => void (refuse = why), failStart: (why: string | null) => void (startFails = why), whenStarted: (fn: () => void) => void (onStart = fn) };
}

/** A standing team with the given agents on it; the first leads it. */
async function seat(world: World, cwds: string[]) {
  const team = await world.createTeam({ name: "Mission Control", standing: true });
  const agents = cwds.map((cwd) => world.state().agents.find((a) => a.cwd === cwd)!);
  agents.forEach((a, i) => world.updateAgent(a.id, { teamId: team.id, role: i === 0 ? "lead" : "member" }));
  return { team, agents };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repository on `dev` with one commit, and a project worktree `repo-atoms-light` beside it. */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "world-repo-")));
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  const atoms = join(dir, "repo-atoms-light");
  git(root, "worktree", "add", "-q", "-b", "worktree-atoms-light", atoms);
  return { dir, root, atoms };
}

/** The text of a message as typed, without the header and footer around it. */
const body = (typed: string) => typed.split("\n\n")[1];

const lane = (paneId: string, cwd: string, sessionId: string, status: LiveAgent["status"] = "idle"): LiveAgent =>
  ({ paneId, harness: "pi", sessionId, cwd, status, title: null, name: null });

test("an agent keeps its name when its session restarts in the same checkout", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/repo-einstein", "session-1")]);
  const before = world.state().agents[0]!;
  setLive([lane("p7", "/repo-einstein", "session-2", "working")]);
  const after = world.state().agents[0]!;
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
  assert.equal(after.status, "working");
  assert.equal(after.paneId, "p7");
});

test("every agent gets its own name, and two agents in one checkout are two people", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/a", "s1"), lane("p2", "/a", "s2"), ...Array.from({ length: 30 }, (_, i) => lane(`q${i}`, `/c${i}`, `t${i}`))]);
  const agents = world.state().agents;
  assert.equal(agents.length, 32);
  assert.equal(new Set(agents.map((a) => a.id)).size, 32);
  assert.equal(new Set(agents.map((a) => a.name)).size, 32);
});

test("a standing team keeps its members' desks; someone in the lounge just leaves", async () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/lead", "s1"), lane("p2", "/idle", "s2")]);
  const { team } = await seat(world, ["/lead"]);
  setLive([]);
  const agents = world.state().agents;
  assert.deepEqual(agents.map((a) => [a.cwd, a.status, a.teamId, a.role]), [["/lead", "offline", team.id, "lead"]]);
});

test("an offline standing-team member leaves when another agent runs in the same checkout, on the team or not", async () => {
  const { root } = repository();
  const src = join(root, "src");
  mkdirSync(src);
  const { world, setLive } = setup();
  setLive([lane("p1", root, "s1"), lane("p2", "/elsewhere", "s2"), lane("p3", "/other", "s3")]);
  const { team, agents } = await seat(world, [root, "/elsewhere", "/other"]);
  const [lead, same, kept] = agents as [(typeof agents)[0], (typeof agents)[0], (typeof agents)[0]];
  // The lead is replaced by a session in a subfolder of its checkout, which is placed nowhere; another by one on the team.
  const claude = (paneId: string, cwd: string): LiveAgent => ({ ...lane(paneId, cwd, `c-${paneId}`), harness: "claude" });
  setLive([claude("p4", src), claude("p5", "/elsewhere"), lane("p6", "/other", "s6")]);
  const replacement = world.state().agents.find((a) => a.cwd === "/elsewhere" && a.harness === "claude");
  world.updateAgent(replacement!.id, { teamId: team.id });
  setLive([claude("p4", src), claude("p5", "/elsewhere")]);
  const state = world.state();
  assert.deepEqual(state.agents.find((a) => a.id === lead.id)?.teamId ?? null, null, "replaced by one placed nowhere, the lead leaves");
  assert.equal(state.agents.find((a) => a.id === same.id)?.teamId ?? null, null, "replaced by one on the team, the member leaves");
  assert.equal(state.agents.find((a) => a.id === kept.id)?.teamId, team.id, "nobody else in its checkout: the desk stays");
  const onTeam = state.agents.filter((a) => a.teamId === team.id);
  assert.deepEqual(onTeam.map((a) => a.id).sort(), [kept.id, replacement!.id].sort());
  assert.deepEqual(onTeam.filter((a) => a.role === "lead").length, 1, "the next lead is appointed");
  // The record is kept: what it said keeps its sender.
  const said = world.messages.say(lead, { to: "Mission Control", text: "old news" });
  assert.equal(world.state().messages.find((m) => m.id === said.id)?.fromAgentId, lead.id);
});

test("a project's offline lead keeps its desk beside its own members, and anywhere nobody else runs", () => {
  const { atoms } = repository();
  const { world, setLive } = setup();
  setLive([lane("p1", atoms, "s1")]);
  const first = world.state().agents[0]!;
  assert.equal(first.role, "lead");
  setLive([]);
  assert.deepEqual(world.state().agents.map((a) => [a.id, a.status, a.role]), [[first.id, "offline", "lead"]]);
  setLive([{ ...lane("p2", atoms, "s2"), harness: "claude" }]);
  const state = world.state();
  assert.equal(state.agents.length, 2, "the new member joins the project; the lead's desk stays for it to take over");
  assert.equal(state.agents.filter((a) => a.role === "lead").length, 1);
});

test("a team has one lead, leaving drops the role, and disbanding a standing team sends everyone to the lounge", async () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/a", "s1"), lane("p2", "/b", "s2")]);
  const [a, b] = world.state().agents;
  const team = await world.createTeam({ name: "Crew", standing: true });
  world.updateAgent(a!.id, { teamId: team.id, role: "lead" });
  world.updateAgent(b!.id, { teamId: team.id, role: "lead" });
  assert.equal(world.agent(a!.id).role, "member");
  assert.equal(world.agent(b!.id).role, "lead");
  assert.equal(world.updateAgent(b!.id, { teamId: null }).role, "member");
  assert.equal(world.agent(a!.id).role, "lead", "a team with anyone on it always has a lead");
  assert.match((await world.deleteTeam(team.id)).note, /disbanded/);
  assert.deepEqual(world.state().agents.map((x) => x.teamId), [null, null]);
  await assert.rejects(world.createTeam({ name: "  " }), /needs a name/);
});

test("an agent working in a worktree is on that project, named after it, and the first one there leads it", () => {
  const { root, atoms } = repository();
  const { world, setLive } = setup();
  setLive([
    { ...lane("p1", atoms, "s1"), harness: "claude" },
    { ...lane("p2", root, "s2") },
  ]);
  const { teams, agents } = world.state();
  assert.deepEqual(teams.map((t) => [t.name, t.path, t.branch, t.standing]), [["Atoms light", atoms, "worktree-atoms-light", false]]);
  const lead = agents.find((a) => a.paneId === "p1")!;
  assert.deepEqual([lead.teamId, lead.role, lead.project], [teams[0]!.id, "lead", "repo"]);
  assert.equal(agents.find((a) => a.paneId === "p2")!.teamId, null, "the main checkout is no project");

  // The first mate's crew shares its worktree; herdr knows each by name, so each is its own person.
  setLive([{ ...lane("p1", atoms, "s1"), harness: "claude" }, { ...lane("p3", atoms, "s3"), harness: "claude", name: "tests" }]);
  const crew = world.state().agents.find((a) => a.paneId === "p3")!;
  assert.equal(crew.identity, `claude:${atoms}@tests`);
  assert.deepEqual([crew.teamId, crew.role], [teams[0]!.id, "member"]);

  // Crew who stop running leave; the first mate keeps its desk.
  setLive([]);
  assert.deepEqual(world.state().agents.map((a) => [a.id, a.status]), [[lead.id, "offline"]]);
});

test("starting a project makes its worktree beside the repository and starts a first mate there", async () => {
  const { dir, root } = repository();
  const { world, setLive, started, prompts } = setup();
  setLive([lane("p1", root, "s1")]);
  const qa = await world.createTeam({ name: "QA", standing: true });
  const team = await world.createTeam({ name: "Frontpage video!", purpose: "A live simulation on the front page", handsTo: qa.id, repository: root });
  assert.deepEqual([team.path, team.branch, team.standing], [join(dir, "repo-frontpage-video"), "worktree-frontpage-video", false]);
  assert.equal(git(team.path!, "rev-parse", "--abbrev-ref", "HEAD"), "worktree-frontpage-video");
  assert.equal(git(team.path!, "rev-parse", "HEAD"), git(root, "rev-parse", "dev"), "branched from the main checkout's branch");

  const [lead] = started;
  assert.deepEqual([lead!.pane, lead!.name], ["w2:p1", "lead-frontpage-video"]);
  assert.deepEqual(lead!.args.slice(0, 4), ["--model", "opus", "--effort", "medium"]);
  const brief = lead!.args[lead!.args.indexOf("--append-system-prompt") + 1]!;
  assert.match(brief, /first mate/);
  assert.match(brief, /You do not write the code yourself/);
  assert.match(brief, /herdr agent start <name> --kind <kind> --pane "\$P" -- <model>/);
  assert.match(brief, /`P=\$\('[^']*bin\/inbox' pane\)` opens a pane in your tab, laid out with the others as a grid/);
  assert.ok(!brief.includes("herdr pane split"), "crew panes come from inbox pane, which lays them out");
  assert.match(brief, /by the founder's crew guide, a decision tree they edit: `inbox crew` prints it with the exact start command/);
  assert.ok(!/exactly one of three|--model sonnet|gpt-6-astra/.test(brief), "the choices live in the crew tree, not in the brief");
  assert.match(brief, /Never any other kind or model/);
  assert.match(brief, /hand it to QA for review/);
  assert.ok(!lead!.args.some((a) => a.startsWith("Start on the project")), "started with its brief only, so herdr sees it ready");
  assert.deepEqual(prompts, [{ pane: "w2:p1", text: "Start on the project: A live simulation on the front page" }], "then given its first task");

  await assert.rejects(world.createTeam({ name: "frontpage video!", repository: root }), /already a project or team called/);
  await assert.rejects(world.createTeam({ name: "Frontpage video", repository: root }), /repo-frontpage-video already exists/);
  await assert.rejects(world.createTeam({ name: "Other", repository: "/nowhere" }), /pick the repository/);
  await assert.rejects(world.createTeam({ name: "42", repository: root }), /start the project's name with a letter/);

  // A repository nobody works in yet is named by its main checkout, never by one of its worktrees.
  const other = repository();
  await assert.rejects(world.createTeam({ name: "Inside", repository: other.atoms }), /pick the repository/);
  const fresh = await world.createTeam({ name: "Agent office", repository: other.root });
  assert.equal(fresh.path, join(other.dir, "repo-agent-office"));
});

test("a multi-paragraph purpose gives the first mate single-line, control-free arguments", async () => {
  const { root } = repository();
  const { world, started, prompts } = setup();
  const purpose = "Keep the founder's words.\n\nThen review\t\tthe result.";
  const team = await world.createTeam({ name: "Review paragraphs", purpose, repository: root });
  const { args } = started[0]!;
  const brief = args[args.indexOf("--append-system-prompt") + 1]!;
  for (const arg of args) assert.doesNotMatch(arg, /[\p{Cc}\u2028\u2029]/u);
  assert.ok(brief.includes("The project: Keep the founder's words. Then review the result."));
  assert.equal(team.purpose, purpose, "the stored purpose keeps its paragraphs");
  assert.deepEqual(prompts, [{ pane: "w2:p1", text: `Start on the project: ${purpose}` }], "the typed kickoff is not a shell argument");
});

test("first-mate briefs normalize names and all controls without escaping quotes or losing Unicode", async () => {
  const { root } = repository();
  const { world, started } = setup();
  const qa = await world.createTeam({ name: "QA\n\t\u001b\u007f\u009f café 👩‍💻", standing: true });
  const controls = Array.from({ length: 65 }, (_, i) => String.fromCharCode(i < 32 ? i : i + 95)).join("");
  const purpose = `Keep "quotes", 'apostrophes', back\\slashes, $dollars and \`backticks\`.\r\n\nReview\t café\u0085世界\u00a0👩‍💻\u2028next\u2029paragraph. Remove con\u0000\u0007\u001btrols. ${controls} Done.`;
  await world.createTeam({ name: "Review\n\t\u0007 '世界'", purpose, handsTo: qa.id, repository: root });
  const { args } = started[0]!;
  const brief = args[args.indexOf("--append-system-prompt") + 1]!;
  for (const arg of args) assert.doesNotMatch(arg, /[\p{Cc}\u2028\u2029]/u);
  assert.doesNotMatch(brief, / {2}/);
  assert.ok(brief.includes(`You run the project "Review '世界'"`));
  assert.ok(brief.includes("hand it to QA café 👩‍💻 for review"));
  assert.ok(brief.includes("The project: Keep \"quotes\", 'apostrophes', back\\slashes, $dollars and `backticks`. Review café 世界 👩‍💻 next paragraph. Remove controls. Done."));
});

/** A main checkout with one commit, in any folder. */
function initRepository(root: string, branch = "main") {
  execFileSync("git", ["init", "-q", "-b", branch, root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
}

test("a project's worktree and branch for a repository with a space in its name", () => {
  assert.deepEqual(placeFor("/Users/me/projects/motion video", "Atoms light!"), {
    slug: "atoms-light",
    path: "/Users/me/projects/motion video-atoms-light",
    branch: "worktree-atoms-light",
  });
});

test("checkoutsIn lists the main checkouts one level down, not worktrees, plain folders or nested repositories", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "world-scan-")));
  initRepository(join(dir, "motion video"));
  initRepository(join(dir, "alpha"), "dev");
  git(join(dir, "alpha"), "worktree", "add", "-q", "-b", "worktree-x", join(dir, "alpha-x"));
  mkdirSync(join(dir, "notes"));
  mkdirSync(join(dir, "group"));
  initRepository(join(dir, "group", "deep"));
  initRepository(join(dir, ".hidden"));
  assert.deepEqual(checkoutsIn(dir).map((c) => [c.name, c.root, c.branch]), [
    ["alpha", join(dir, "alpha"), "dev"],
    ["motion video", join(dir, "motion video"), "main"],
  ]);
  assert.deepEqual(checkoutsIn(join(dir, "missing")), []);
});

test("a new repository beside the ones agents work in is offered, known ones first; a project there works with a space in its name", async () => {
  const { dir, root, atoms } = repository();
  initRepository(join(dir, "motion video"));
  initRepository(join(dir, "aardvark"));
  mkdirSync(join(dir, "plain"));
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const t = setup(() => new Date(clock));
  const { world } = t;
  t.setLive([lane("p1", atoms, "s1")]);
  const names = () => world.state().repositories.map((r) => r.name);
  assert.deepEqual(names(), ["repo", "aardvark", "motion video"], "the repository in use first, then the others by name; worktrees and plain folders are not repositories");

  initRepository(join(dir, "brand new"));
  assert.ok(!names().includes("brand new"), "the scan is cached for a few seconds");
  clock += 10_000;
  assert.deepEqual(names(), ["repo", "aardvark", "brand new", "motion video"]);

  const motion = world.state().repositories.find((r) => r.name === "motion video")!;
  assert.deepEqual([motion.root, motion.base], [join(dir, "motion video"), "main"]);
  const team = await world.createTeam({ name: "Title cards", repository: motion.root });
  assert.deepEqual([team.path, team.branch], [join(dir, "motion video-title-cards"), "worktree-title-cards"]);
  assert.equal(git(team.path!, "rev-parse", "--abbrev-ref", "HEAD"), "worktree-title-cards");
  const [lead] = t.started;
  assert.equal(lead!.name, "lead-title-cards");
  const settings = lead!.args.indexOf("--settings");
  if (settings >= 0) JSON.parse(lead!.args[settings + 1]!);
  assert.equal(world.state().teams.find((x) => x.id === team.id)?.name, "Title cards");
  assert.ok(names().includes("motion video"), "the repository stays listed once it has a project");
});

test("finishing a project closes its agents and removes the worktree, but never loses work", async () => {
  const { root, atoms } = repository();
  const { world, setLive, closed } = setup();
  setLive([lane("p1", atoms, "s1", "working"), lane("p9", root, "s9")]);
  const team = world.state().teams[0]!;
  await assert.rejects(world.deleteTeam(team.id), /is still working/);

  setLive([lane("p1", atoms, "s1", "idle"), lane("p9", root, "s9")]);
  writeFileSync(join(atoms, "b.txt"), "b\n");
  await assert.rejects(world.deleteTeam(team.id), /1 uncommitted change in .*: commit or discard it first/);

  git(atoms, "add", ".");
  git(atoms, "commit", "-qm", "b");
  // A dev server left running there outlives its pane.
  const server = spawn("sleep", ["60"], { cwd: join(atoms), stdio: "ignore" });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  const { note } = await world.deleteTeam(team.id);
  assert.deepEqual(closed, ["p1"], "only the agents working in it are closed");
  await exited;
  assert.match(note, /Stopped what was still running there: sleep\./);
  assert.equal(existsSync(atoms), false);
  assert.match(note, /Branch worktree-atoms-light is kept: 1 commit is not in dev yet/);
  assert.equal(git(root, "branch", "--list", "worktree-atoms-light"), "worktree-atoms-light");
  assert.deepEqual(world.state().teams, []);
});

test("a finished project's merged branch is deleted, and a project whose worktree is gone is over", async () => {
  const { root, atoms } = repository();
  const { world, setLive } = setup();
  setLive([lane("p1", atoms, "s1")]);
  const team = world.state().teams[0]!;
  assert.match((await world.deleteTeam(team.id)).note, /Branch worktree-atoms-light was merged and is deleted/);
  assert.equal(git(root, "branch", "--list", "worktree-atoms-light"), "");

  const again = repository();
  setLive([lane("p1", again.atoms, "s1")]);
  assert.equal(world.state().teams.length, 1);
  setLive([]);
  git(again.root, "worktree", "remove", again.atoms);
  assert.deepEqual(world.state().teams, [], "removed outside the office");
});

test("an agent known only from the inbox appears offline with its project and its tasks", () => {
  const { inbox, world } = setup();
  const { taskId } = inbox.submit({
    session: { harness: "codex", sessionId: "thread-1" },
    project: { name: "Accounts", root: "/demo/accounts" },
    item: { type: "milestone", title: "Import works" },
  });
  const [agent] = world.state().agents;
  assert.equal(agent?.status, "offline");
  assert.equal(agent?.project, "Accounts");
  assert.deepEqual(agent?.taskIds, [taskId]);
});

test("your message to one agent is typed into its terminal once it is free, from the founder", async () => {
  const { world, prompts, setLive } = setup();
  setLive([lane("p1", "/tom", "s1", "working")]);
  const tom = world.state().agents[0]!;
  const sent = world.messages.tell(tom.id, { text: "Rail first, please", clientId: "c1" });
  assert.equal(world.messages.tell(tom.id, { text: "Rail first, please", clientId: "c1" }).id, sent.id, "a retried send is the same message");
  await world.react();
  assert.equal(prompts.length, 0, "not while it works");
  setLive([lane("p1", "/tom", "s1", "idle")]);
  await world.react();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!.text, /^\[Message from the founder\]\n\nRail first, please/);
  assert.throws(() => world.messages.tell("nobody", { text: "hi" }), /no agent/);
});

test("an agent answers the founder in the office: a thread with them, typed into nobody's terminal", async () => {
  const { inbox, world, prompts, setLive } = setup();
  setLive([lane("p1", "/tom", "s1", "idle"), lane("p2", "/ann", "s2", "idle")]);
  const [tom, ann] = world.state().agents.filter((a) => a.cwd === "/tom" || a.cwd === "/ann").sort((a) => (a.cwd === "/tom" ? -1 : 1));
  world.messages.tell(tom!.id, { text: "Rail first, please" });
  await world.react();
  assert.match(prompts[0]!.text, /inbox say founder "…"/, "the founder's message says how to answer");
  assert.match(prompts[0]!.text, /follow up the same way/);

  const reply = world.messages.say(tom!, { to: "Founder", text: "On it; the rail lands after the login fix.", clientId: "r1" });
  assert.equal(reply.toFounder, true);
  assert.deepEqual(reply.deliveries, [], "nobody's terminal gets it");
  assert.equal(world.messages.say(tom!, { to: "founder", text: "On it; the rail lands after the login fix.", clientId: "r1" }).id, reply.id, "a retried answer is the same message");
  world.messages.say(ann!, { to: "founder", text: "Unrelated: tests are green." });
  await world.react();
  assert.equal(prompts.length, 1, "an answer is never typed anywhere");

  const thread = world.state().withFounder.filter((m) => (m.toFounder ? m.fromAgentId === tom!.id : m.deliveries.some((d) => d.agentId === tom!.id))).reverse();
  assert.deepEqual(thread.map((m) => [m.fromAgentId ? "tom" : "you", m.text]), [["you", "Rail first, please"], ["tom", "On it; the rail lands after the login fix."]]);
  assert.equal(inbox.state().items.length, 0, "not a question in the review inbox");
  assert.equal(world.state().withFounder.filter((m) => m.toFounder).length, 2);

  assert.throws(() => world.updateAgent(ann!.id, { name: "Founder" }), /how agents address you/);
});

/** herdr's view of a new project's lead: Claude in the pane the worktree was made with. */
const leadIn = (path: string, status: LiveAgent["status"]): LiveAgent => ({ paneId: "w2:p1", harness: "claude", sessionId: "lead-session", cwd: path, status, title: null, name: "lead-cosmology" });

test("a first mate herdr did not see as ready in time, but which is running, still starts the project", async () => {
  const { dir, root } = repository();
  const { world, setLive, prompts, failStart, whenStarted } = setup();
  setLive([lane("p1", root, "s1")]);
  failStart("timed out waiting for agent startup");
  // Claude is there and working when herdr gives up waiting for it to look ready.
  const path = join(dir, "repo-cosmology");
  whenStarted(() => setLive([lane("p1", root, "s1"), leadIn(path, "working")]));
  const team = await world.createTeam({ name: "Cosmology", purpose: "The cosmology lesson", repository: root });
  assert.equal(team.path, path);
  assert.deepEqual(prompts, [{ pane: "w2:p1", text: "Start on the project: The cosmology lesson" }]);
});

test("a first mate that is running but cannot take its first task now gets it as a message once free", async () => {
  const { dir, root } = repository();
  const { world, setLive, prompts, refuse, whenStarted } = setup();
  setLive([lane("p1", root, "s1")]);
  whenStarted(() => setLive([lane("p1", root, "s1"), leadIn(join(dir, "repo-cosmology"), "blocked")]));
  refuse("the agent is asking something");
  await world.createTeam({ name: "Cosmology", purpose: "The cosmology lesson", repository: root });
  assert.equal(prompts.length, 0);
  const lead = world.state().agents.find((a) => a.paneId === "w2:p1")!;
  assert.equal(world.state().teams.find((t) => t.name === "Cosmology")?.id, lead.teamId, "the lead is on its project");
  const queued = world.state().withFounder.find((m) => m.deliveries.some((d) => d.agentId === lead.id));
  assert.equal(queued?.text, "Start on the project: The cosmology lesson");
  assert.equal(queued?.deliveries[0]!.state, "queued", "typed once the lead is free");
});

test("whoever runs in the first mate's pane leads the project, even after herdr loses its name", async () => {
  const { dir, root } = repository();
  const { world, setLive, prompts, failStart, whenStarted } = setup();
  const path = join(dir, "repo-cosmology");
  setLive([lane("p1", root, "s1")]);
  failStart("timed out waiting for agent startup");
  whenStarted(() => setLive([lane("p1", root, "s1"), leadIn(path, "working")]));
  const team = await world.createTeam({ name: "Cosmology", purpose: "The cosmology lesson", repository: root });
  const named = world.state().agents.find((a) => a.paneId === "w2:p1")!;
  assert.equal(named.role, "lead");

  // herdr drops the name, briefly loses the pane, and you tell the lead something meanwhile.
  setLive([lane("p1", root, "s1")]);
  const offline = world.state().agents.find((a) => a.id === named.id)!;
  assert.equal(offline.status, "offline");
  const told = world.messages.tell(named.id, { text: "Use the new star map" });
  const crew = { ...lane("p3", path, "crew-session", "working"), name: null };
  setLive([lane("p1", root, "s1"), { ...leadIn(path, "idle"), name: null }, crew]);

  const onTeam = world.state().agents.filter((a) => a.teamId === team.id);
  const lead = onTeam.find((a) => a.paneId === "w2:p1")!;
  assert.deepEqual([lead.role, lead.name], ["lead", named.name], "the running agent is the lead, under the name you know");
  assert.equal(onTeam.filter((a) => a.role === "lead").length, 1);
  assert.ok(!world.state().agents.some((a) => a.id === named.id), "no lead left offline for ever");
  assert.deepEqual(world.state().withFounder.find((m) => m.id === told.id)?.deliveries.map((d) => d.agentId), [lead.id], "what was said to it reaches it");
  await world.react();
  assert.ok(prompts.some((p) => p.pane === "w2:p1" && p.text.includes("Use the new star map")));

  // A lead you pick is yours to pick while it runs.
  const other = onTeam.find((a) => a.paneId === "p3")!;
  world.updateAgent(other.id, { role: "lead" });
  assert.equal(world.state().agents.find((a) => a.id === other.id)?.role, "lead");
  assert.equal(world.state().agents.find((a) => a.id === lead.id)?.role, "member");
});

/**
 * A project from before the office remembered its first mate's pane: the lead record herdr named
 * is offline, and the same agent runs unnamed beside a crew member, both on the project as crew.
 */
async function strandedLead() {
  const { dir, root } = repository();
  const t = setup();
  const path = join(dir, "repo-cosmology");
  t.setLive([lane("p1", root, "s1")]);
  t.whenStarted(() => t.setLive([lane("p1", root, "s1"), leadIn(path, "working")]));
  const team = await t.world.createTeam({ name: "Cosmology", repository: root });
  const ada = t.world.state().agents.find((a) => a.paneId === "w2:p1")!;
  t.db.prepare("UPDATE teams SET lead_pane = NULL").run();
  const told = t.world.messages.tell(ada.id, { text: "Use the new star map" });
  t.setLive([lane("p1", root, "s1"), { ...leadIn(path, "idle"), name: null }, { ...lane("p3", path, "crew-session", "working"), name: null }]);
  const onTeam = t.world.state().agents.filter((a) => a.teamId === team.id);
  const unnamed = onTeam.find((a) => a.paneId === "w2:p1")!;
  const crew = onTeam.find((a) => a.paneId === "p3")!;
  assert.deepEqual(onTeam.find((a) => a.id === ada.id)?.status, "offline", "the old lead record is stranded");
  return { ...t, root, path, team, ada, told, unnamed, crew };
}

test("someone nobody runs can be removed; the next running member leads, and what they said stays", async () => {
  const { world, setLive, root, path, team, ada, told, unnamed, crew } = await strandedLead();
  const said = world.messages.say(ada, { to: crew.name, text: "Crew, start on the stars" });
  assert.throws(() => world.removeAgent(unnamed.id), (err: Error & { status?: number }) => err.status === 409 && /running in herdr/.test(err.message));

  world.removeAgent(ada.id);
  const state = world.state();
  assert.ok(!state.agents.some((a) => a.id === ada.id), "gone from the office");
  const leads = state.agents.filter((a) => a.teamId === team.id && a.role === "lead");
  assert.equal(leads.length, 1);
  assert.ok([unnamed.id, crew.id].includes(leads[0]!.id) && leads[0]!.status !== "offline", "a running member leads");
  assert.deepEqual(state.withFounder.find((m) => m.id === told.id)?.deliveries, [], "what waited for it is dropped");
  const kept = state.messages.find((m) => m.id === said.id)!;
  assert.deepEqual([kept.fromAgentId, kept.text], [ada.id, "Crew, start on the stars"], "what it said keeps its text and sender");

  // Running again under that identity brings it back.
  setLive([lane("p1", root, "s1"), leadIn(path, "idle")]);
  assert.equal(world.state().agents.find((a) => a.id === ada.id)?.name, ada.name);
});

test("a running agent can take over an offline lead, with its name and what was said to it", async () => {
  const { world, ada, told, unnamed, crew, prompts } = await strandedLead();
  assert.equal(ada.ran, true);
  world.updateAgent(unnamed.id, { role: "lead", takeName: true });
  const state = world.state();
  const lead = state.agents.find((a) => a.id === unnamed.id)!;
  assert.deepEqual([lead.role, lead.name], ["lead", ada.name]);
  assert.ok(!state.agents.some((a) => a.id === ada.id));
  assert.deepEqual(state.withFounder.find((m) => m.id === told.id)?.deliveries.map((d) => d.agentId), [lead.id]);
  await world.react();
  assert.ok(prompts.some((p) => p.pane === "w2:p1" && p.text.includes("Use the new star map")));
  // A lead who is running keeps their place and name.
  assert.throws(() => world.updateAgent(crew.id, { role: "lead", takeName: true }), (err: Error & { status?: number }) => err.status === 409 && /is running/.test(err.message));
});

test("a first mate that did not start at all is reported plainly, with the worktree kept", async () => {
  const { dir, root } = repository();
  const { world, setLive, prompts, failStart } = setup();
  setLive([lane("p1", root, "s1")]);
  failStart("timed out waiting for agent startup");
  await assert.rejects(
    world.createTeam({ name: "Cosmology", purpose: "The cosmology lesson", repository: root }),
    (err: Error & { status?: number }) => {
      assert.match(err.message, /The worktree .*repo-cosmology is made, but no first mate is running in it \(herdr: timed out waiting for agent startup\)\. Start one there in herdr, or finish the project\./);
      return true;
    },
  );
  assert.ok(existsSync(join(dir, "repo-cosmology")));
  assert.equal(prompts.length, 0);
});

test("a team is blocked when its lead is stuck, or when someone is and nobody else is working", async () => {
  const { world, setLive } = setup();
  const statusWith = (lead: LiveAgent["status"], crew: LiveAgent["status"]) => {
    setLive([lane("p1", "/lead", "s1", lead), lane("p2", "/crew", "s2", crew)]);
    return world.state().teams[0]!.status;
  };
  setLive([lane("p1", "/lead", "s1"), lane("p2", "/crew", "s2")]);
  await seat(world, ["/lead", "/crew"]);
  assert.equal(statusWith("working", "blocked"), "working", "the lead handles a stuck crew member");
  assert.equal(statusWith("blocked", "working"), "blocked");
  assert.equal(statusWith("idle", "blocked"), "blocked", "nobody left working");
  assert.equal(statusWith("done", "idle"), "idle");
  setLive([]);
  assert.equal(world.state().teams[0]!.status, "offline");
});

test("a lead waiting on your answer in the inbox blocks the team", async () => {
  const { inbox, world, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "working"), lane("p2", "/crew", "s2", "working")]);
  await seat(world, ["/lead", "/crew"]);
  inbox.submit({ session: { harness: "pi", sessionId: "s1" }, item: { type: "decide", title: "Which way?", options: ["A", "B"], blocking: true } });
  const { teams, agents } = world.state();
  assert.equal(teams[0]!.status, "blocked");
  assert.deepEqual(teams[0]!.blockedBy, [agents.find((a) => a.cwd === "/lead")!.id]);
});

test("a team is announced once when it becomes blocked, and not for how things stood at start", async () => {
  const { world, notices, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "blocked")]);
  await seat(world, ["/lead"]);
  await world.react();
  assert.deepEqual(notices, [], "already blocked when the service started");
  setLive([lane("p1", "/lead", "s1", "working")]);
  await world.react();
  setLive([lane("p1", "/lead", "s1", "blocked")]);
  await world.react();
  await world.react();
  assert.deepEqual(notices, ["Mission Control is blocked"]);
});

test("an instruction goes to the team's lead once it is free, with its crew named", async () => {
  const { world, prompts, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "working"), lane("p2", "/crew", "s2", "idle")]);
  const { team, agents } = await seat(world, ["/lead", "/crew"]);
  const order = world.messages.instruct(team.id, { text: "Ship the login page", clientId: "c1" });
  assert.deepEqual(order.deliveries.map((d) => [d.agentId, d.state]), [[agents[0]!.id, "queued"]]);
  await world.react();
  assert.equal(prompts.length, 0, "the lead is busy");
  setLive([lane("p1", "/lead", "s1", "done"), lane("p2", "/crew", "s2", "idle")]);
  await Promise.all([world.react(), world.react()]);
  assert.equal(prompts.length, 1, "typed once, however many reactions race");
  assert.equal(prompts[0]!.pane, "p1");
  assert.match(prompts[0]!.text, /You lead Mission Control/);
  assert.match(prompts[0]!.text, new RegExp(agents[1]!.name));
  assert.equal(body(prompts[0]!.text), "Ship the login page");
  assert.equal(world.state().messages[0]!.deliveries[0]!.state, "delivered");
  assert.equal(world.messages.instruct(team.id, { text: "Ship the login page", clientId: "c1" }).id, order.id, "a retried request is the same order");
});

test("a lead speaking to its own team is heard by its crew, and a failed delivery can be retried", async () => {
  const { world, prompts, setLive, refuse } = setup();
  setLive([lane("p1", "/lead", "s1"), lane("p2", "/a", "s2"), lane("p3", "/b", "s3")]);
  const { agents } = await seat(world, ["/lead", "/a", "/b"]);
  const lead = agents[0]!;
  refuse("agent_blocked");
  const first = world.messages.say(lead, { to: "Mission Control", text: "first" });
  const second = world.messages.say(lead, { to: "Mission Control", text: "second" });
  await world.react();
  const failed = world.state().messages.find((m) => m.id === first.id)!;
  assert.deepEqual(failed.deliveries.map((d) => [d.state, d.error]), [["failed", "agent_blocked"], ["failed", "agent_blocked"]]);
  assert.deepEqual(world.state().messages.find((m) => m.id === second.id)!.deliveries.map((d) => d.state), ["failed", "failed"], "what was typed together fails together");
  refuse(null);
  await world.react();
  assert.equal(prompts.length, 0, "a failed delivery waits for Retry");
  world.messages.retry(first.id, agents[1]!.id);
  await world.react();
  assert.deepEqual(prompts.map((p) => [p.pane, body(p.text)]), [["p2", "first"]]);
  assert.throws(() => world.messages.retry(first.id, agents[1]!.id), /only a failed delivery/);
});

test("an instruction needs someone to hear it", async () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/crew", "s1")]);
  const team = await world.createTeam({ name: "Crew", standing: true });
  assert.throws(() => world.messages.instruct(team.id, { text: "go" }), /nobody is on Crew yet/);
  world.updateAgent(world.state().agents[0]!.id, { teamId: team.id });
  assert.equal(world.messages.instruct(team.id, { text: "go" }).deliveries.length, 1, "whoever is on it leads it");
  assert.throws(() => world.messages.instruct(team.id, { text: " " }), /needs some text/);
});

test("an agent hears its messages in the order they were sent, in one prompt, even while another is still busy", async () => {
  const { world, prompts, setLive } = setup();
  setLive([lane("p0", "/lead", "s0"), lane("p1", "/a", "s1", "working"), lane("p2", "/b", "s2", "idle")]);
  const { agents } = await seat(world, ["/lead", "/a", "/b"]);
  world.messages.say(agents[0]!, { to: "Mission Control", text: "first" });
  world.messages.say(agents[0]!, { to: "Mission Control", text: "second" });
  await world.react();
  assert.equal(prompts.length, 1, "p2 is free, so it hears both, in one prompt; p1 is busy and hears nothing yet");
  assert.equal(prompts[0]!.pane, "p2");
  assert.match(prompts[0]!.text, /2 messages arrived[\s\S]*first[\s\S]*second/);
  await world.react();
  assert.equal(prompts.filter((p) => p.pane === "p1").length, 0);
});

test("agents talk to each other by name, and a team hears it through its lead", async () => {
  const { world, prompts, setLive } = setup();
  setLive([lane("p1", "/lead", "s1"), lane("p2", "/crew", "s2"), lane("p3", "/other", "s3")]);
  const { agents } = await seat(world, ["/lead", "/crew"]);
  const other = world.state().agents.find((a) => a.cwd === "/other")!;
  const crew = world.resolve({ harness: "pi", sessionId: "s2" });
  assert.equal(crew.id, agents[1]!.id, "a session is found through herdr");
  world.messages.say(other, { to: crew.name.toUpperCase(), text: "Can you look at the login test?" });
  world.messages.say(other, { to: "mission control", text: "Who owns the tutor?" });
  await world.react();
  await world.react();
  const typed = prompts.map((p) => [p.pane, body(p.text)]);
  assert.deepEqual(typed, [["p2", "Can you look at the login test?"], ["p1", "Who owns the tutor?"]]);
  assert.match(prompts[0]!.text, new RegExp(`Message from ${other.name}`));
  assert.match(prompts[0]!.text, new RegExp(`inbox say "${other.name}"`));
  assert.throws(() => world.messages.say(other, { to: other.name, text: "hi" }), /that is you/);
  assert.throws(() => world.messages.say(other, { to: "Nobody", text: "hi" }), /nobody called/);
});

test("finished work goes to the team a team hands to, and the verdict comes back to whoever handed it over", async () => {
  const { world, prompts, setLive } = setup();
  setLive([lane("p1", "/dev", "s1"), lane("p2", "/qa1", "s2"), lane("p3", "/qa2", "s3")]);
  const qa = (await seat(world, ["/qa1", "/qa2"])).team;
  world.updateTeam(qa.id, { name: "QA", purpose: "Review every handoff for correctness and tests" });
  const dev = await world.createTeam({ name: "Dev", standing: true, handsTo: qa.id });
  const coder = world.state().agents.find((a) => a.cwd === "/dev")!;
  world.updateAgent(coder.id, { teamId: dev.id });
  const me = world.resolve({ harness: "pi", sessionId: "s1" });

  const { work } = world.messages.handoff(me, { title: "Login page", summary: "Done in src/login.ts; run npm test" });
  assert.equal(work.toTeamId, qa.id);
  await world.react();
  assert.deepEqual(prompts.map((p) => p.pane), ["p2"], "QA's lead hears it");
  assert.match(prompts[0]!.text, new RegExp(`inbox review ${work.id} accept`));
  assert.match(prompts[0]!.text, /Review every handoff for correctness/);

  const reviewer = world.resolve({ harness: "pi", sessionId: "s2" });
  assert.throws(() => world.messages.review(me, { work: work.id, verdict: "accept" }), /only the team/);
  assert.throws(() => world.messages.review(reviewer, { work: work.id, verdict: "changes" }), /say what needs to change/);
  world.messages.review(reviewer, { work: work.id, verdict: "changes", notes: "The empty password case is not handled" });
  await world.react();
  assert.equal(prompts.at(-1)!.pane, "p1");
  assert.match(prompts.at(-1)!.text, /Changes requested/);
  assert.match(prompts.at(-1)!.text, new RegExp(`inbox handoff --work ${work.id}`));

  const again = world.messages.handoff(me, { work: work.id, summary: "Empty passwords are refused now" }).work;
  assert.deepEqual([again.state, again.round, again.notes], ["in_review", 2, ""]);
  assert.throws(() => world.messages.handoff(me, { work: work.id, summary: "again" }), /still under review/);
  await assert.rejects(world.deleteTeam(qa.id), /under review/);
  world.messages.review(reviewer, { work: work.id, verdict: "accept" });
  assert.equal(world.state().work[0]!.state, "accepted");
  assert.match(world.brief({ harness: "pi", sessionId: "s1" }).text, /Your handoff .* accepted/);
  assert.throws(() => world.messages.handoff(me, { title: "x", summary: "y", to: "Nowhere" }), /no team called/);
});

test("a handoff needs somewhere to go", async () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/dev", "s1")]);
  const me = world.state().agents[0]!;
  assert.throws(() => world.messages.handoff(me, { title: "Login", summary: "done" }), /does not hand its work to anyone/);
  const team = await world.createTeam({ name: "Dev", standing: true });
  world.updateAgent(me.id, { teamId: team.id });
  assert.throws(() => world.messages.handoff(world.agent(me.id), { title: "Login", summary: "done", to: "dev" }), /not your own/);
});

test("inbox team tells an agent its team, its part and how to reach the others", async () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/lead", "s1"), lane("p2", "/crew", "s2", "working")]);
  const { team, agents } = await seat(world, ["/lead", "/crew"]);
  world.updateTeam(team.id, { purpose: "Fix founder comments in the lessons" });
  const text = world.brief({ paneId: "p2" }).text;
  assert.match(text, new RegExp(`You are ${agents[1]!.name}`));
  assert.match(text, new RegExp(`${agents[0]!.name} leads it`));
  assert.match(text, /Purpose: Fix founder comments/);
  assert.match(text, /inbox say NAME/);
  assert.throws(() => world.brief({ paneId: "nope" }), /does not know this session/);
});

test("an agent can send more than 30 messages in an hour, including to the founder", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/a", "s1"), lane("p2", "/b", "s2")]);
  const [a, b] = world.state().agents;
  for (let i = 0; i < 31; i++) {
    world.messages.say(a!, { to: b!.name, text: `ping ${i}` });
    world.messages.say(a!, { to: "founder", text: `update ${i}` });
  }
  assert.equal(world.state().withFounder.filter((message) => message.toFounder && message.fromAgentId === a!.id).length, 31);
});

test("inbox team tells a first mate how to run its crew, and its crew to report to it", () => {
  const { atoms } = repository();
  const { world, setLive } = setup();
  world.crew = new CrewTreeStore(mkdtempSync(join(tmpdir(), "world-crew-")), { piStore: "/nowhere" });
  setLive([lane("p1", atoms, "s1")]);
  world.state();
  setLive([lane("p1", atoms, "s1"), { ...lane("p2", atoms, "s2"), name: "tests" }]);
  const [mate, crew] = ["p1", "p2"].map((p) => world.state().agents.find((a) => a.paneId === p)!);
  const told = world.brief({ paneId: "p1" }).text;
  assert.match(told, new RegExp(`Project: Atoms light, in the worktree ${atoms}`));
  assert.match(told, new RegExp(`Your office name is ${mate!.name}. You are the project's first mate`));
  assert.match(told, /Crew guide/, "a first mate reads the current tree in `inbox team`");
  assert.match(told, /Do not answer acknowledgments or thanks, and tell your crew not to either/);
  assert.match(told, /Start: herdr agent start <name> --kind claude --pane "\$P" -- --model sonnet --effort high/);
  assert.match(world.brief({ paneId: "p2" }).text, new RegExp(`${mate!.name} is its first mate: .*inbox say ${mate!.name}`));
  assert.equal(crew!.role, "member");
});

test("an edit to the crew tree reaches a running first mate's next `inbox team`, and crew never see the tree", () => {
  const { atoms } = repository();
  const { world, setLive } = setup();
  const crew = new CrewTreeStore(mkdtempSync(join(tmpdir(), "world-crew-")), { piStore: "/nowhere" });
  world.crew = crew;
  setLive([lane("p1", atoms, "s1")]);
  world.state();
  setLive([lane("p1", atoms, "s1"), lane("p2", atoms, "s2")]);
  const mate = world.state().agents.find((a) => a.paneId === "p1")!;
  assert.equal(mate.role, "lead");
  assert.match(world.brief({ paneId: "p1" }).text, /--model sonnet --effort high/);
  const edited = structuredClone(crew.state().tree);
  edited.rules[2]!.when = "Typos and one-line fixes.";
  edited.rules[2]!.use!.model = "haiku";
  crew.save(edited);
  const after = world.brief({ paneId: "p1" }).text;
  assert.match(after, /Typos and one-line fixes\./);
  assert.match(after, /--model haiku --effort high/);
  assert.doesNotMatch(world.brief({ paneId: "p2" }).text, /Crew guide/, "only a first mate chooses models");
});

test("a project's lead starts on the crew tree's lead choice under the founder's switch, with its brief either way", async () => {
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const crewDir = mkdtempSync(join(tmpdir(), "world-lead-"));
  const lead = async (mode: string | null, name: string) => {
    const { root } = repository();
    const { world, started, prompts } = setup();
    const crew = new CrewTreeStore(crewDir, { piStore: "/nowhere" });
    if (mode) crew.save({ ...crew.state().tree, mode });
    world.crew = crew;
    await world.createTeam({ name, purpose: "Build it.", repository: root });
    return { first: started[0]!, prompts };
  };

  const mixed = await lead("mixed", "Mixed project");
  assert.equal(mixed.first.harness, "claude");
  assert.deepEqual(mixed.first.args.slice(0, 4), ["--model", "opus", "--effort", "medium"]);
  assert.ok(mixed.first.args.includes("--append-system-prompt"));

  const claude = await lead("claude", "Claude project");
  assert.equal(claude.first.harness, "claude");
  assert.deepEqual(claude.first.args.slice(0, 4), ["--model", "opus", "--effort", "medium"]);

  // Pi takes the brief as an appended system prompt and its model and level as one flag; Claude's hook settings do not apply.
  const pi = await lead("pi", "Pi project");
  assert.equal(pi.first.harness, "pi");
  assert.deepEqual(pi.first.args.slice(0, 2), ["--model", "openai-codex/gpt-6-astra:high"]);
  assert.ok(!pi.first.args.includes("--settings") && !pi.first.args.includes("--effort"));
  const brief = flag(pi.first.args, "--append-system-prompt");
  assert.match(brief, /first mate/);
  assert.match(brief, /never start the harness it says is switched off/);
  assert.match(brief, /`inbox crew` says so/);
  assert.deepEqual(pi.prompts, [{ pane: "w2:p1", text: "Start on the project: Build it." }], "its first task follows as a prompt, as for Claude");

  // The founder's switch decides at the moment a project starts, whatever was saved before.
  const back = await lead("mixed", "Back again");
  assert.equal(back.first.harness, "claude");
});

test("team names are unique, since agents address teams by name", async () => {
  const { world } = setup();
  await world.createTeam({ name: "QA", standing: true });
  await assert.rejects(world.createTeam({ name: "qa", standing: true }), /already a project or team called/);
  const other = await world.createTeam({ name: "Dev", standing: true });
  assert.throws(() => world.updateTeam(other.id, { handsTo: other.id }), /itself/);
});

test("the office shows what an agent is doing and the helpers it has running", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "working")]);
  const me = { harness: "pi" as const, sessionId: "s1", paneId: "p1" };
  const agent = () => world.state().agents[0]!;
  world.report(me, [{ kind: "tool", tool: "edit", input: { path: "/lead/src/login.ts" }, callId: "c1" }]);
  assert.equal(agent().doing, "Editing login.ts");
  world.report(me, [{ kind: "tool", tool: "agents", callId: "c2", input: { calls: [{ name: "architecture-reviewer" }, { name: "physics-accuracy-reviewer" }] } }]);
  assert.deepEqual(agent().helpers.map((h) => h.type), ["architecture-reviewer", "physics-accuracy-reviewer"]);
  assert.equal(agent().doing, "Briefing 2 helpers");
  world.report(me, [{ kind: "tool_end", callId: "c2" }]);
  assert.deepEqual(agent().helpers, []);
  setLive([lane("p1", "/lead", "s1", "idle")]);
  assert.equal(agent().doing, null, "an idle agent is doing nothing, whatever it last reported");
  assert.deepEqual(world.report({ harness: "pi", sessionId: "gone" }, [{ kind: "idle" }]), { ok: false }, "an unknown session is ignored");
});

test("an agent shows the model its harness reports, only for the session that reported it", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "working")]);
  const me = { harness: "pi" as const, sessionId: "s1", paneId: "p1" };
  const agent = () => world.state().agents[0]!;
  assert.equal(agent().model, null, "nothing is shown before the harness says");
  world.report(me, [{ kind: "tool", tool: "read", input: {} }]);
  assert.equal(agent().model, null, "a tool call says nothing about the model");
  world.report(me, [{ kind: "idle" }, { kind: "model", model: { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" } }]);
  assert.deepEqual(agent().model, { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" });
  world.report(me, [{ kind: "model", model: { id: "openai/gpt-5", label: "GPT-5" } }]);
  assert.equal(agent().model?.label, "GPT-5", "a model switched mid-session replaces the old one");
  setLive([lane("p1", "/lead", "s2", "idle")]);
  assert.equal(agent().model, null, "a new session in the same pane has not said which model it runs");
});

test("a Claude Code hook call becomes activity, with a sub-agent's own tools kept apart", () => {
  const hook = (event: string, extra: Record<string, unknown> = {}) => claudeHookEvents({ hook_event_name: event, session_id: "s", ...extra });
  assert.deepEqual(hook("SubagentStart", { agent_id: "h1", agent_type: "architecture-reviewer" }).events, [{ kind: "helper_start", helperId: "h1", helperType: "architecture-reviewer" }]);
  assert.deepEqual(hook("PreToolUse", { agent_id: "h1", tool_name: "Read", tool_input: {} }), { events: [], helperId: "h1" });
  assert.deepEqual(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test", description: "Run the tests" } }).events, [{ kind: "tool", tool: "Bash", input: { command: "npm test", description: "Run the tests" } }]);
  assert.deepEqual(hook("Stop").events, [{ kind: "idle" }]);
  assert.equal(describeTool("Bash", { command: "npm test" }), "Running npm test");
  assert.equal(describeTool("Grep", { pattern: "useFrame" }), "Searching for useFrame");
});
