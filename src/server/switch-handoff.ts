// The handoff the office writes itself, for an agent that cannot write its own (its model is
// unavailable): only facts the office already has or can read locally (its record, its checkout's
// git state, where its old transcript is, its open inbox items and what waits for it). No model is
// called and nothing is summarised: the new session reads the old transcript to recover context.
//
// Which switches use it is the founder's explicit choice (`inbox switch NAME --no-handoff`), kept
// in `agent_switch_handoffs` beside the switch row so that a restart keeps it.

import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Harness, WorldAgent, WorldState } from "../shared/types.ts";
import { HARNESS_INFO } from "../shared/harnesses.ts";
import { DEFAULT_ROOTS } from "./models.ts";
import { laneAgent, type LaneRegistration } from "./queue.ts";

/** The line every factual handoff carries, so the new session knows what it is reading. */
export const FACTUAL_NOTICE = "The old session could not write a handoff (its model is unavailable). Read the old transcript's last part before acting, and do not redo finished work.";

const MAX_STATUS_LINES = 200;
const MAX_MESSAGE_CHARS = 600;
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;
type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

/** The table that marks a switch as one whose handoff the office writes. Owned here, created on start. */
export function ensureHandoffModes(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_switch_handoffs (
    switch_id TEXT PRIMARY KEY REFERENCES agent_switches(id),
    mode TEXT NOT NULL CHECK (mode IN ('factual'))
  )`);
}

export function markFactual(db: DatabaseSync, switchId: string): void {
  db.prepare("INSERT OR REPLACE INTO agent_switch_handoffs (switch_id, mode) VALUES (?, 'factual')").run(switchId);
}

export function isFactual(db: DatabaseSync, switchId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM agent_switch_handoffs WHERE switch_id = ? AND mode = 'factual'").get(switchId));
}

/**
 * Where an old session's transcript is: Pi's session id is its file; Claude Code's is
 * `<root>/<project folder>/<session id>.jsonl`. Null when the office does not know it.
 */
export function transcriptPath(harness: Harness, sessionId: string | null, claudeRoot: string = DEFAULT_ROOTS.claude): string | null {
  if (!sessionId) return null;
  if (harness === "pi") return isAbsolute(sessionId) && sessionId.endsWith(".jsonl") ? sessionId : null;
  if (harness === "claude" && SAFE_ID.test(sessionId)) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(claudeRoot);
    } catch {
      return null;
    }
    for (const dir of dirs) {
      const path = join(claudeRoot, dir, `${sessionId}.jsonl`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

export interface HandoffFacts {
  agent: WorldAgent;
  state: WorldState;
  from: Harness;
  to: Harness;
  /** The old session's id as herdr reported it, when it is running. */
  sessionId: string | null;
  /** The old session's transcript, when the office knows where it is. */
  transcript: string | null;
  registered: LaneRegistration;
}

/** The standing lanes this agent stands behind, joined as the queue joins them: "project/lane". */
function lanesOf(agent: WorldAgent, state: WorldState, registered: LaneRegistration): string[] {
  return state.repositories.flatMap((repo) => (repo.adapter?.lanes ?? [])
    .filter((lane) => laneAgent(lane, state.agents, registered(repo.root, lane, state))?.id === agent.id)
    .map((lane) => `${repo.adapter!.project}/${lane.name}`));
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 }).trimEnd();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return `(unavailable: ${(str(e.stderr).trim() || e.message).split("\n")[0]})`;
  }
}

/** The handoff's text: facts only, each section saying plainly when there is nothing. */
export function factualHandoff(db: DatabaseSync, facts: HandoffFacts): string {
  const { agent, state, from, to } = facts;
  const team = agent.teamId ? state.teams.find((t) => t.id === agent.teamId) ?? null : null;
  const lanes = lanesOf(agent, state, facts.registered);
  const lines: string[] = [
    `# Handoff for ${agent.name} (written by the office)`,
    "",
    FACTUAL_NOTICE,
    "",
    "## Who you are",
    `- Name: ${agent.name}`,
    `- Team: ${team ? `${team.name}${team.standing ? " (standing team)" : ""}` : "none"}`,
    `- Role: ${agent.role}`,
    `- Lane: ${lanes.length ? lanes.join(", ") : "none"}`,
    `- Moved from ${HARNESS_INFO[from].label} to ${HARNESS_INFO[to].label}`,
    "",
    "## The old transcript",
  ];
  if (facts.transcript) {
    lines.push(`- ${facts.transcript}${existsSync(facts.transcript) ? "" : " (the office could not find this file just now)"}`,
      `- It is the old ${HARNESS_INFO[from].label} session's JSONL log; read its last part (for example \`tail -n 200 ${facts.transcript}\`) to see what it was doing.`);
  } else {
    lines.push(`- Not known to the office${facts.sessionId ? ` (session id ${facts.sessionId})` : agent.paneId ? "" : `: ${agent.name} was not running`}.`);
  }

  lines.push("", "## Checkout");
  if (agent.cwd) {
    const status = git(agent.cwd, ["status", "--short"]);
    const statusLines = status ? status.split("\n") : [];
    lines.push(`- Directory: ${agent.cwd}`,
      `- Branch: ${git(agent.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])}`,
      `- HEAD: ${git(agent.cwd, ["rev-parse", "HEAD"])}`,
      "- Uncommitted (`git status --short`):");
    if (!statusLines.length) lines.push("  (nothing uncommitted)");
    else {
      lines.push("```", ...statusLines.slice(0, MAX_STATUS_LINES), "```");
      if (statusLines.length > MAX_STATUS_LINES) lines.push(`  (${statusLines.length - MAX_STATUS_LINES} more lines; run \`git status --short\` yourself)`);
    }
  } else {
    lines.push("- No checkout is known.");
  }

  lines.push("", "## Open review-inbox items");
  const items = agent.taskIds.length
    ? db.prepare(`SELECT i.key, i.type, i.title, i.state, i.revision, i.blocking, t.title AS task FROM items i JOIN tasks t ON t.id = i.task_id
        WHERE i.task_id IN (${agent.taskIds.map(() => "?").join(",")}) AND i.state NOT IN ('resolved', 'withdrawn') ORDER BY i.created_at`).all(...agent.taskIds) as Row[]
    : [];
  if (!items.length) lines.push("- None.");
  for (const i of items) lines.push(`- [${str(i.state)}] ${str(i.type)} "${str(i.title)}" (key ${str(i.key)}, revision ${str(i.revision)}${Number(i.blocking) ? ", blocking" : ""}; task "${str(i.task)}")`);

  lines.push("", "## Messages not yet delivered to you");
  const waiting = db.prepare(`SELECT d.state, d.error, m.kind, m.text, m.created_at, m.from_agent_id, a.name AS from_name FROM message_deliveries d
      JOIN messages m ON m.id = d.message_id LEFT JOIN world_agents a ON a.id = m.from_agent_id
      WHERE d.agent_id = ? AND d.state != 'delivered' ORDER BY m.created_at`).all(agent.id) as Row[];
  if (!waiting.length) lines.push("- None.");
  for (const m of waiting) {
    const text = str(m.text).replace(/\s+/g, " ").trim();
    const who = m.from_agent_id ? str(m.from_name) || "an agent" : "the founder or the office";
    lines.push(`- [${str(m.state)}${m.error ? `: ${str(m.error)}` : ""}] ${str(m.kind)} from ${who}, ${str(m.created_at)}: ${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`);
  }
  if (waiting.some((m) => m.state === "queued" || m.state === "sending")) lines.push("  Queued messages reach you after your brief; you do not need to fetch them.");

  lines.push("", "## How to continue", "Read the old transcript's last part, check the checkout above, then run `inbox team`. Carry on where the work stands; do not redo what is already committed or answered.", "");
  return lines.join("\n");
}

/** Writes the handoff whole (a temporary file renamed in place), so a reader never sees half of it. Rewriting it is safe. */
export function writeHandoff(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
