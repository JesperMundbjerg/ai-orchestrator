import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, TeamStatus, WorldAgent, WorldTeam } from "../src/shared/types.ts";
import type { Corner } from "../src/ui/world/layout.ts";
import { FIGURE_WIDTH, figureGrid, nameLines, teamBoard, wobble, wrap } from "../src/ui/world/corkboard.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: "t", role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra,
});
const team = (extra: Partial<Team> = {}): Team => ({ id: "t", name: "Voice Teacher", purpose: "", handsTo: null, path: "/repo-t", branch: "worktree-voice-teacher", standing: false, createdAt: "", ...extra });
const corner = (t: Team, members: WorldAgent[]): Corner => ({ team: t, center: [0, 0], facing: 0, desks: [], members });
const live = (t: Team, status: TeamStatus, blockedBy: string[] = []): Map<string, WorldTeam> => new Map([[t.id, { ...t, status, blockedBy }]]);
/** Every character as wide as half its size. */
const measure = (text: string, size: number) => text.length * size * 0.5;

test("a board counts every member and, below them, those working now", () => {
  const members = [agent("a", { status: "working" }), agent("b"), agent("c", { status: "working" }), agent("d", { status: "blocked" })];
  const board = teamBoard(corner(team(), members), new Map(members.map((m) => [m.id, m])), live(team(), "working"), []);
  assert.equal(board.members, 4);
  assert.equal(board.working, 2);
  assert.equal(board.note, null, "the green men say it is working");
});

test("a blocked team gets a red note naming who holds it up; the card says its branch, or Always on", () => {
  const anton = agent("anton", { name: "Anton", status: "blocked" });
  const blocked = teamBoard(corner(team(), [anton]), new Map([[anton.id, anton]]), live(team(), "blocked", [anton.id]), []);
  assert.deepEqual(blocked.note, { status: "blocked", text: "Blocked: Anton is stuck at a prompt" });
  assert.deepEqual(blocked.card, ["worktree-voice-teacher"]);
  const standing = team({ standing: true, branch: null, path: null });
  assert.deepEqual(teamBoard(corner(standing, []), new Map(), live(standing, "idle"), []).card, ["Always on"]);
});

test("the card says what the team hands on and has to review", () => {
  const qa = team({ id: "qa", name: "QA" });
  const t = team({ handsTo: "qa" });
  const teams = new Map<string, WorldTeam>([[t.id, { ...t, status: "idle", blockedBy: [] }], [qa.id, { ...qa, status: "idle", blockedBy: [] }]]);
  const work = [{ toTeamId: "t", state: "in_review" }, { toTeamId: "t", state: "done" }] as never;
  assert.deepEqual(teamBoard(corner(t, []), new Map(), teams, work).card, ["worktree-voice-teacher", "1 to review", "hands its work to QA"]);
});

test("stickmen stay inside their box, one each, however many there are that fit", () => {
  for (const count of [1, 3, 7, 12, 30, 60]) {
    const g = figureGrid(count, 800, 180, 120, 22);
    if (g.tally) continue;
    assert.equal(g.cells.length, count);
    for (const [x, y] of g.cells) {
      assert.ok(x - (g.size * FIGURE_WIDTH) / 2 >= -1e-9 && x + (g.size * FIGURE_WIDTH) / 2 <= 800 + 1e-9, `x ${x} for ${count}`);
      assert.ok(y - g.size / 2 >= -1e-9 && y + g.size / 2 <= 180 + 1e-9, `y ${y} for ${count}`);
    }
  }
});

test("a few stickmen are large and in one row; thirty shrink and wrap into rows but stay readable", () => {
  const three = figureGrid(3, 800, 180, 120, 22);
  assert.equal(three.size, 120);
  assert.equal(new Set(three.cells.map(([, y]) => y)).size, 1);
  const thirty = figureGrid(30, 800, 180, 120, 22);
  assert.equal(thirty.tally, null);
  assert.ok(thirty.size < 120 && thirty.size >= 22);
  assert.ok(new Set(thirty.cells.map(([, y]) => y)).size > 1, "thirty wrap into rows");
});

test("when even the smallest stickmen cannot all fit, one stands for them with a tally", () => {
  const g = figureGrid(500, 300, 60, 60, 30);
  assert.equal(g.tally, 500);
  assert.equal(g.cells.length, 1);
  assert.deepEqual(figureGrid(0, 800, 180, 120, 22), { size: 0, cells: [], tally: null });
});

test("a name fills one line up to its largest size, goes to two lines when long, and is cut only as a last resort", () => {
  assert.deepEqual(nameLines("Accounts", 1000, 150, 60, measure), { size: 150, lines: ["Accounts"] });
  const long = nameLines("The very long project name here", 1000, 150, 90, measure);
  assert.equal(long.lines.length, 2);
  for (const l of long.lines) assert.ok(measure(l, long.size) <= 1000 + 1e-9);
  const cut = nameLines("Supercalifragilisticexpialidocious", 400, 150, 60, measure);
  assert.equal(cut.lines.length, 1);
  assert.ok(cut.lines[0]!.endsWith("…") && measure(cut.lines[0]!, 60) <= 400);
});

test("a note wraps between words within its width and keeps to its lines", () => {
  const lines = wrap("Blocked: Anton and Vera and Nora are stuck at a prompt", 300, 30, measure, 3);
  assert.ok(lines.length <= 3);
  for (const l of lines) assert.ok(measure(l, 30) <= 300);
  assert.equal(wrap("Always on", 300, 30, measure, 3).join(" "), "Always on");
  assert.deepEqual(wrap("worktree-voice-teacher", 300, 30, measure, 3), ["worktree-voice-", "teacher"], "a branch breaks after a hyphen");
});

test("a board's wobble is small and the same every time it is painted", () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(wobble("team", i), wobble("team", i));
    assert.ok(Math.abs(wobble("team", i)) <= 1);
  }
  assert.notEqual(wobble("a", 1), wobble("b", 1));
});
