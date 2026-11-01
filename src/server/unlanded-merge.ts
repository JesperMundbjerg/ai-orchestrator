// A team's merge instruction: how its agents land finished work ("land <checkout> <sha>", a command
// file such as .claude/commands/worktree-sync.md). Set by the founder as text, a file in the team's
// repository, or both, and delivered by the office wherever it tells someone to land work: in every
// lead and crew brief, and in the nudge to an agent that went idle with work that never landed
// (unlanded.ts). The file is read when the words are made, never cached, so an edit reaches the next
// nudge or brief. Its reading and limits are the lead role's (leadrole.ts).
//
// The setting lives in its own table, created here, so it needs no numbered migration.

import type { DatabaseSync } from "node:sqlite";
import { ROLE_PATH_MAX_CHARS, ROLE_TEXT_MAX_CHARS, readRoleFile, type LeadRoleSetting } from "./leadrole.ts";

export const MERGE_TEXT_MAX_CHARS = ROLE_TEXT_MAX_CHARS;
export const MERGE_PATH_MAX_CHARS = ROLE_PATH_MAX_CHARS;
/** The most of a merge file put in one brief or nudge; a longer file is cut there and says where to read the rest. */
export const MERGE_FILE_DELIVER_CHARS = 6000;

export type MergeSetting = LeadRoleSetting;

type Row = Record<string, unknown>;

export class MergeInstructions {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS team_merge_instructions (
      team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT ''
    )`);
  }

  get(teamId: string): MergeSetting {
    const r = this.db.prepare("SELECT text, path FROM team_merge_instructions WHERE team_id = ?").get(teamId) as Row | undefined;
    return { text: r ? String(r.text) : "", path: r ? String(r.path) : "" };
  }

  /** Sets the given fields; an empty one clears it. */
  set(teamId: string, patch: Partial<MergeSetting>): MergeSetting {
    const next = { ...this.get(teamId), ...patch };
    if (!next.text && !next.path) this.db.prepare("DELETE FROM team_merge_instructions WHERE team_id = ?").run(teamId);
    else this.db.prepare("INSERT INTO team_merge_instructions (team_id, text, path) VALUES (?, ?, ?) ON CONFLICT (team_id) DO UPDATE SET text = excluded.text, path = excluded.path").run(teamId, next.text, next.path);
    return next;
  }
}

/** What the team panel shows about the merge file: null when all is well or no file is set. */
export function mergeFileProblem(setting: MergeSetting, roots: readonly string[]): string | null {
  return setting.path ? readRoleFile(setting.path, roots).problem : null;
}

/**
 * The instruction as an agent is given it: the founder's text, then the file as it is now between
 * markers. Null when the team has none. A file that cannot be read is said, never skipped silently.
 */
export function mergeInstructionBody(teamName: string, setting: MergeSetting, roots: readonly string[]): string | null {
  const lines: string[] = [];
  if (setting.text) lines.push(setting.text);
  if (setting.path) {
    const file = readRoleFile(setting.path, roots);
    if (file.content) {
      const cut = file.content.length > MERGE_FILE_DELIVER_CHARS;
      const shown = cut ? `${file.content.slice(0, MERGE_FILE_DELIVER_CHARS)}\n…` : file.content;
      const note = [file.problem, cut ? `only the first ${MERGE_FILE_DELIVER_CHARS} characters are shown here; read the rest in ${file.resolved}` : null].filter(Boolean).join("; ");
      lines.push(`${teamName}'s merge file ${setting.path}, read just now from ${file.resolved}${note ? ` (${note})` : ""}:`, "--- begin merge instruction ---", shown, "--- end merge instruction ---");
    } else {
      lines.push(`The office could not give you ${teamName}'s merge file ${setting.path}: ${file.problem}. Land the way your team lands work, and tell the founder the file is unreadable.`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

/** The line every brief carries: how to land when the work is done. Empty when the team has no merge instruction. */
export function mergeBrief(teamName: string, setting: MergeSetting, roots: readonly string[], landing: string | null, lead: boolean): string {
  const body = mergeInstructionBody(teamName, setting, roots);
  if (!body) return "";
  const share = lead ? " Give it to every crew member you assign work, and check their work has landed before you report it done." : "";
  return `When your work is done, land it${landing ? ` on ${landing}` : ""} with ${teamName}'s merge instruction, then say it has landed:\n${body}${share}`;
}
