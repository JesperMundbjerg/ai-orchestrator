// A team's corkboard, the one board on its wall: what it says and where things go on it. Pure,
// so the painting (CorkBoard.tsx) only draws what this lays out, and only when it changes.

import type { TeamStatus, Work, WorldAgent, WorldTeam } from "../../shared/types.ts";
import { whyStuck } from "../../shared/stuck.ts";
import type { Corner } from "./spatial.ts";

export interface Board {
  /** Cut out of paper, across the top. */
  name: string;
  /** The small card: what the team is (its branch, or "Always on") and the work it hands on and gets. */
  card: string[];
  /** A note for how the team is doing; blocked is red. None while it works: the green men say so. */
  note: { status: TeamStatus; text: string } | null;
  /** One paper stickman each; null where there is nobody to count, as on a free bay's board. */
  members: number | null;
  /** One green stickman each, under the members. */
  working: number;
  /** Keeps a board's letters and pins where they were when it is painted again. */
  seed: string;
}

/** What a team's board says: its name, what it is, how it is doing, and the work it hands on and gets. */
export function teamBoard({ team, members }: Corner, agents: Map<string, WorldAgent>, teams: Map<string, WorldTeam>, work: Work[]): Board {
  const live = teams.get(team.id) ?? null;
  const toReview = work.filter((w) => w.toTeamId === team.id && w.state === "in_review").length;
  const handsTo = team.handsTo ? teams.get(team.handsTo)?.name : null;
  const card = [
    team.standing ? "Always on" : (team.branch ?? "worktree"),
    ...(toReview ? [`${toReview} to review`] : []),
    ...(handsTo ? [`hands its work to ${handsTo}`] : []),
  ];
  const status = live?.status ?? null;
  const note =
    status === "blocked" ? { status, text: `Blocked: ${whyStuck(live!.blockedBy.flatMap((id) => agents.get(id) ?? []))}` }
    : status === "idle" ? { status, text: "Idle: ready for work" }
    : status === "offline" && members.length ? { status, text: "Everyone offline" }
    : null;
  return { name: team.name, card, note, members: members.length, working: members.filter((m) => m.status === "working").length, seed: team.id };
}

/** A bay no team has yet. */
export function freeBoard(seed: string): Board {
  return { name: "Free workshop", card: ["for the next project"], note: null, members: null, working: 0, seed };
}

/** A stickman is this wide and this far from the next, as parts of its height. */
export const FIGURE_WIDTH = 0.6;
const STEP_X = 0.72;
const STEP_Y = 1.08;

export interface Grid {
  /** A stickman's height. */
  size: number;
  /** Where each stickman's middle is, from the box's top left. */
  cells: Array<[number, number]>;
  /** Set when there are too many to show one each at `min`: one stickman stands for them, with "×n" beside it. */
  tally: number | null;
}

/**
 * Stickmen for `count` in a box: as large as fit, up to `max`, wrapping into rows that are
 * centred; when even `min` would not fit them all, one stickman with a tally.
 */
export function figureGrid(count: number, width: number, height: number, max: number, min: number): Grid {
  if (count <= 0) return { size: 0, cells: [], tally: null };
  for (let size = max; size >= min; size *= 0.96) {
    const cols = Math.max(1, Math.floor((width - size * FIGURE_WIDTH) / (size * STEP_X)) + 1);
    const rows = Math.ceil(count / cols);
    if (size * FIGURE_WIDTH > width || size + (rows - 1) * size * STEP_Y > height) continue;
    const cells: Array<[number, number]> = [];
    const top = (height - (size + (rows - 1) * size * STEP_Y)) / 2 + size / 2;
    for (let r = 0; r < rows; r++) {
      const inRow = Math.min(cols, count - r * cols);
      const left = (width - (inRow - 1) * size * STEP_X) / 2;
      for (let c = 0; c < inRow; c++) cells.push([left + c * size * STEP_X, top + r * size * STEP_Y]);
    }
    return { size, cells, tally: null };
  }
  const size = Math.min(max, height);
  return { size, cells: [[size * FIGURE_WIDTH, height / 2]], tally: count };
}

type Measure = (text: string, size: number) => number;

/** Two lines of the name take this much of the height one line may have, each. */
export const TWO_LINES = 0.62;

/**
 * The name in one line as large as fits up to `max`; when that is under `min`, over two lines
 * split between words where the longer line is shortest; failing that, one line cut short.
 */
export function nameLines(name: string, width: number, max: number, min: number, measure: Measure): { size: number; lines: string[] } {
  const text = name.trim();
  const one = Math.min(max, (width * max) / measure(text, max));
  if (one >= min) return { size: one, lines: [text] };
  const words = text.split(/\s+/);
  const longest = (ls: string[]) => Math.max(...ls.map((l) => measure(l, max)));
  const best = words.slice(1).map((_, i) => [words.slice(0, i + 1).join(" "), words.slice(i + 1).join(" ")]).sort((x, y) => longest(x) - longest(y))[0];
  if (best) {
    const two = Math.min(max * TWO_LINES, (width * max) / longest(best));
    if (two >= min) return { size: two, lines: best };
  }
  return { size: min, lines: [cut(text, width, min, measure)] };
}

function cut(text: string, width: number, size: number, measure: Measure): string {
  if (measure(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && measure(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

/**
 * Text broken between words, or after a hyphen or slash (a branch name), into lines no wider
 * than `width`: at most `most` of them, the last cut short.
 */
export function wrap(text: string, width: number, size: number, measure: Measure, most: number): string[] {
  const pieces = text.split(/\s+/).filter(Boolean).flatMap((word) => word.split(/(?<=[-/])(?=.)/).map((t, i) => ({ t, space: i === 0 })));
  const lines: string[] = [];
  for (const { t, space } of pieces) {
    const last = lines.at(-1);
    const joined = last === undefined ? t : `${last}${space ? " " : ""}${t}`;
    if (last !== undefined && measure(joined, size) <= width) lines[lines.length - 1] = joined;
    else lines.push(t);
  }
  if (lines.length > most) lines.splice(most - 1, lines.length - most + 1, lines.slice(most - 1).join(" "));
  return lines.map((l) => cut(l, width, size, measure));
}

/** A small, steady wobble in [-1, 1] for the `i`th thing on a board: the same every time it is painted. */
export function wobble(seed: string, i: number): number {
  let h = 2166136261;
  for (const ch of `${seed}#${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}
