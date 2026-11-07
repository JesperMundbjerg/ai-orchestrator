import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { Switches, type SwitchSource } from "../src/server/switch.ts";
import { DELEGATION_RULE, ROLE_FILE_MAX_BYTES, STANDING_LEAD_ROLE } from "../src/server/leadrole.ts";
import { InboxError } from "../src/server/inbox.ts";
import { withInboxPath } from "../src/server/inboxtext.ts";
import { inboxCommand } from "../src/shared/pipeline-cli.ts";

const TIMING = { pollMs: 5, freeMs: 2000, handoffMs: 2000, quietMs: 60_000 };
const ROLE_FILE = ".claude/commands/mission-control.md";
const ROLE = "Own getting queued comments into working lanes. Do not implement.";

/** herdr as the switch sees it, and what is typed into each pane. */
function fakeHerdr() {
  let live: LiveAgent[] = [];
  const prompts: Array<{ pane: string; text: string }> = [];
  const cwds = new Map<string, string>();
  let panes = 0;
  const source: SwitchSource = {
    available: () => true,
    live: () => live,
    prompt: async (pane, text) => void prompts.push({ pane, text }),
    notify: async () => {},
    createWorktree: async () => ({ paneId: "unused" }),
    startAgent: async (pane, name, harness) => {
      live = [...live, { paneId: pane, harness, sessionId: `session-${pane}`, cwd: cwds.get(pane) ?? null, status: "idle", title: null, name }];
    },
    closePane: async (pane) => void (live = live.filter((a) => a.paneId !== pane)),
    removeWorktree: async () => {},
    refresh: async () => {},
    openPane: async (cwd) => {
      const pane = `new${++panes}`;
      cwds.set(pane, cwd);
      return pane;
    },
    renameAgent: async (pane, name) => void (live = live.map((a) => (a.paneId === pane ? { ...a, name } : a))),
  };
  return { source, prompts, setLive: (next: LiveAgent[]) => void (live = next) };
}

const agent = (paneId: string, cwd: string, harness: LiveAgent["harness"]): LiveAgent =>
  ({ paneId, harness, sessionId: `session-${paneId}`, cwd, status: "idle", title: null, name: null });

/** A standing team "Mission Control" of two agents in a real repository that holds a role file; the first leads it. */
async function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "leadrole-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  mkdirSync(join(repo, ".claude/commands"), { recursive: true });
  writeFileSync(join(repo, ROLE_FILE), `${ROLE}\n`);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  const h = fakeHerdr();
  const db = openDatabase(":memory:");
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(dir, "files"), presence);
  const world = new World(db, h.source, () => inbox.state());
  world.crew = new CrewTreeStore(dir, { piStore: join(dir, "none.json") });
  const switches = new Switches(db, world, h.source, dir, { timing: TIMING });
  h.setLive([agent("p1", repo, "pi"), agent("p2", elsewhere, "pi")]);
  const team = await world.createTeam({ name: "Mission Control", standing: true });
  const [l, m] = [world.state().agents.find((a) => a.paneId === "p1")!, world.state().agents.find((a) => a.paneId === "p2")!];
  world.updateAgent(l.id, { teamId: team.id, role: "lead" });
  world.updateAgent(m.id, { teamId: team.id, role: "member" });
  return { dir, repo, elsewhere, h, db, world, switches, team, lead: l, member: m };
}

/** The lead's pane is closed (as in the incident): no handoff, a new Claude Code session takes over. */
async function takeOver(o: Awaited<ReturnType<typeof office>>): Promise<string> {
  o.h.setLive([agent("p2", o.elsewhere, "pi")]);
  assert.equal(o.world.agent(o.lead.id).status, "offline");
  const done = await o.switches.settled(o.switches.start(o.lead.id, { to: "claude" }).id);
  assert.equal(done.step, "done", done.says);
  assert.equal(done.handoff, null, "no handoff");
  return o.h.prompts.filter((p) => p.pane.startsWith("new")).at(-1)!.text;
}

test("a takeover with no handoff gives the new lead its team's role text and the delegation rule", async (t) => {
  const o = await office(t);
  o.world.updateTeam(o.team.id, { leadRole: "Route queued comments to lanes; never implement them." });
  const brief = await takeOver(o);
  assert.match(brief, /there is no handoff/);
  assert.ok(brief.includes(DELEGATION_RULE), "the founder's rule");
  assert.ok(brief.includes("Route queued comments to lanes; never implement them."), "the role text");
  assert.match(brief, /you lead your team/);
});

test("a takeover gives the lead the role file's content, read from the lead's checkout", async (t) => {
  const o = await office(t);
  o.world.updateTeam(o.team.id, { leadRolePath: ROLE_FILE });
  const brief = await takeOver(o);
  assert.ok(brief.includes(ROLE));
  assert.ok(brief.includes(DELEGATION_RULE));
  assert.equal(o.world.state().teams.find((x) => x.id === o.team.id)!.leadRoleProblem, null);
});

test("a missing role file is reported to the lead in its brief and in the team's state, never skipped", async (t) => {
  const o = await office(t);
  o.world.updateTeam(o.team.id, { leadRole: "Dispatch only.", leadRolePath: ".claude/commands/gone.md" });
  const brief = await takeOver(o);
  assert.match(brief, /could not give you Mission Control's lead role file \.claude\/commands\/gone\.md: .*was not found/);
  assert.ok(brief.includes(DELEGATION_RULE), "the rule still comes");
  assert.ok(brief.includes("Dispatch only."), "so does the role text");
  const team = o.world.state().teams.find((x) => x.id === o.team.id)!;
  assert.match(team.leadRoleProblem ?? "", /was not found/);
  assert.equal(team.leadRolePath, ".claude/commands/gone.md");
});

test("a team without a role still gives its lead the delegation rule, on takeover and in `inbox team`", async (t) => {
  const o = await office(t);
  const brief = await takeOver(o);
  assert.ok(brief.includes(DELEGATION_RULE));
  // A standing team without a role of its own (this one) gets the default standing lead role, and nothing else.
  assert.ok(brief.includes(`Mission Control's lead role, the office's default for a standing team until the founder sets one: ${STANDING_LEAD_ROLE.slice(0, 60)}`));
  assert.ok(!brief.includes("lead role file"), "no role file is invented");
  const lead = o.world.agent(o.lead.id);
  const team = o.world.brief({ harness: "claude", sessionId: "session-new1", cwd: o.repo });
  assert.equal(lead.role, "lead");
  assert.ok(team.text.includes(DELEGATION_RULE));
  // A member is not told to lead.
  const member = o.world.brief({ harness: "pi", sessionId: "session-p2", cwd: o.repo });
  assert.ok(!member.text.includes(DELEGATION_RULE));
});

test("the role file is read at each start: an edit is picked up by the next one", async (t) => {
  const o = await office(t);
  o.world.updateTeam(o.team.id, { leadRolePath: ROLE_FILE });
  assert.ok((await takeOver(o)).includes(ROLE));
  writeFileSync(join(o.repo, ROLE_FILE), "A changed role: only dispatch.\n");
  const again = o.world.leadStartFor(o.world.agent(o.lead.id).id)!;
  assert.ok(again.includes("A changed role: only dispatch."));
  assert.ok(!again.includes(ROLE));
});

test("someone made lead is told the rule and the role at once, whoever made them lead", async (t) => {
  const o = await office(t);
  o.world.updateTeam(o.team.id, { leadRole: "Dispatch only." });
  const noRole = () => o.world.messages.list().filter((m) => m.fromOffice && m.text.startsWith("You are now the lead of your team")).length;
  assert.equal(noRole(), 0, "a team with no role queues no notice for its lead");
  const toldCount = () => o.world.messages.list().filter((m) => m.fromOffice && m.text.startsWith("You are now the lead of your team")).length;
  const before = toldCount();
  o.world.updateAgent(o.member.id, { role: "lead" });
  assert.equal(toldCount(), before + 1);
  const told = o.world.messages.list().find((m) => m.fromOffice && m.text.startsWith("You are now the lead of your team") && m.text.includes("Dispatch only."))!;
  assert.ok(told, "the new lead's notice carries the role");
  assert.ok(told.text.includes(DELEGATION_RULE));
  assert.ok(told.text.includes("Dispatch only."));
  // Saying it again changes nothing, so nobody is told twice.
  o.world.updateAgent(o.member.id, { role: "lead" });
  assert.equal(toldCount(), before + 1);
});

test("a role file larger than the cap is cut and says so; one outside the team's checkouts is refused", async (t) => {
  const o = await office(t);
  writeFileSync(join(o.repo, "big.md"), `${"x".repeat(ROLE_FILE_MAX_BYTES)}TAIL`);
  o.world.updateTeam(o.team.id, { leadRolePath: "big.md" });
  const cut = o.world.leadStartFor(o.lead.id)!;
  assert.ok(!cut.includes("TAIL"));
  assert.match(cut, /only the first 24 KB are delivered/);

  const secret = join(o.dir, "secret.md");
  writeFileSync(secret, "SECRETCONTENT");
  symlinkSync(secret, join(o.repo, "link.md"));
  for (const path of ["../secret.md", secret, "link.md"]) {
    o.world.updateTeam(o.team.id, { leadRolePath: path });
    const refused = o.world.leadStartFor(o.lead.id)!;
    assert.ok(!refused.includes("SECRETCONTENT"), path);
    assert.match(refused, /could not give you/, path);
  }
});

test("the setting is validated and cleared with an empty value", async (t) => {
  const o = await office(t);
  assert.throws(() => o.world.updateTeam(o.team.id, { leadRole: "x".repeat(9000) }), (e) => e instanceof InboxError && e.status === 400);
  assert.throws(() => o.world.updateTeam(o.team.id, { leadRolePath: "a\nb" }), (e) => e instanceof InboxError && e.status === 400);
  o.world.updateTeam(o.team.id, { leadRole: "  Dispatch.  ", leadRolePath: ROLE_FILE });
  const set = o.world.state().teams.find((x) => x.id === o.team.id)!;
  assert.deepEqual([set.leadRole, set.leadRolePath], ["Dispatch.", ROLE_FILE]);
  o.world.updateTeam(o.team.id, { leadRole: "", leadRolePath: "" });
  const cleared = o.world.state().teams.find((x) => x.id === o.team.id)!;
  assert.deepEqual([cleared.leadRole, cleared.leadRolePath, cleared.leadRoleProblem], ["", "", null]);
});

test("commands the office tells agents to run carry the CLI's path, and a role file is delivered untouched", async (t) => {
  const o = await office(t);
  writeFileSync(join(o.repo, ROLE_FILE), "Report with inbox say founder when done.\n");
  o.world.updateTeam(o.team.id, { leadRolePath: ROLE_FILE });
  const bin = inboxCommand("team").replace(/ team$/, "");
  const brief = await takeOver(o);
  assert.ok(brief.includes(`${bin} team`), "the takeover brief's `inbox team` is runnable from any pane");
  assert.ok(!/(^|[^/\w])inbox team/.test(brief.replace(/--- begin lead role ---[\s\S]*--- end lead role ---/, "")), "no bare command is left outside the role file");
  assert.ok(brief.includes("Report with inbox say founder when done."), "the founder's file is delivered as written");
  assert.equal(withInboxPath(withInboxPath("run `inbox say x`; the review inbox shows more")), `run \`${bin} say x\`; the review inbox shows more`, "idempotent, and prose about the inbox is left alone");
  const lead = o.world.brief({ harness: "claude", sessionId: "session-new1", cwd: o.repo }).text;
  assert.ok(lead.includes(`${bin} say founder`));
});
