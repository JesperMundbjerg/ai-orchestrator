// A team's lead role: what its lead is for, set by the founder and delivered by the office with
// the delegation rule on every lead start it causes or sees (a new lead, a takeover after a
// switch, someone made lead, `inbox team`). The role is text, a file in the team's repository, or
// both. The file is read when the brief is made, never cached, so an edit reaches the next start.
//
// This is the one place that composes what a lead is told about its role: world.ts and switch.ts
// call `leadBrief`, nothing else words it. The setting lives in its own table, created here, so
// it needs no numbered migration.

import type { DatabaseSync } from "node:sqlite";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** The founder's rule for every lead, office project or standing team. One sentence, worded once. */
export const DELEGATION_RULE = "You lead: plan, split and hand every change, however small, to your crew or lanes; never edit, fix or build yourself.";

/**
 * A standing team's lead role when the team has none of its own (no text, no file): it works like
 * Mission Control's, a read-only lead that investigates briefly and hands every task to a worker in
 * a worktree of its own, split so their work merges without conflicts. A team's own role replaces it.
 */
export const STANDING_LEAD_ROLE = [
  "You lead by delegating only, like Mission Control: you are read-only. You never edit code, commit, review diffs, run checks or fix anything yourself.",
  "For each task or page comment (or group of them): read it (`inbox comment show <id>` for a page comment), do a quick read-only investigation (find the affected files and any real product ambiguity), then hand it to a worker with the ids, the open URL when there is one, and a findings paragraph of at most ~1,200 characters.",
  "Every worker has its own git worktree, made with `inbox pane --worktree <slug>`; hand out work so that no two workers edit the same files or build the same abstraction at once.",
  "Group the tasks or comments by the files they touch. Give each independent group its own worker and start them at the same time, not queued on one worker, up to 4 workers at once. Keep comments together only when they touch the same files or the same abstraction. A busy worker gets more only for files it already has open. Every follow-up goes to the worker that has the original.",
  "Workers mark page comments `inbox comment working|fixed|declined <id>`.",
  "You decide routine technical questions; only a material product or scope fork goes to the founder (`inbox comment ask <id> \"…\"` for a page comment, otherwise `inbox decide`), with the options and your recommendation in at most 400 characters.",
  "Close a worker's pane when its work has landed.",
].join(" ");

/** The role a lead is given: the team's own, or for a standing team without one, `STANDING_LEAD_ROLE`. */
export function effectiveRole(standing: boolean, own: LeadRoleSetting): LeadRoleSetting & { byDefault?: true } {
  return standing && !own.text && !own.path ? { text: STANDING_LEAD_ROLE, path: "", byDefault: true } : own;
}

/** The most of a role file the office delivers; a longer file is cut there and says so. */
export const ROLE_FILE_MAX_BYTES = 24 * 1024;
export const ROLE_TEXT_MAX_CHARS = 8000;
export const ROLE_PATH_MAX_CHARS = 500;

export interface LeadRoleSetting {
  /** The role in words; empty for none. */
  text: string;
  /** A file in the team's repository (relative to a checkout, or absolute inside one); empty for none. */
  path: string;
}

export interface LeadRoleFile {
  /** The file as the lead is given it; null when it could not be read. */
  content: string | null;
  /** Where it was read from. */
  resolved: string | null;
  /** Why it is not (fully) delivered: missing, unreadable, empty or cut. Null when all of it is. */
  problem: string | null;
}

type Row = Record<string, unknown>;

export class LeadRoles {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS team_lead_roles (
      team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT ''
    )`);
  }

  get(teamId: string): LeadRoleSetting {
    const r = this.db.prepare("SELECT text, path FROM team_lead_roles WHERE team_id = ?").get(teamId) as Row | undefined;
    return { text: r ? String(r.text) : "", path: r ? String(r.path) : "" };
  }

  /** Sets the given fields; an empty one clears it. */
  set(teamId: string, patch: Partial<LeadRoleSetting>): LeadRoleSetting {
    const next = { ...this.get(teamId), ...patch };
    if (!next.text && !next.path) this.db.prepare("DELETE FROM team_lead_roles WHERE team_id = ?").run(teamId);
    else this.db.prepare("INSERT INTO team_lead_roles (team_id, text, path) VALUES (?, ?, ?) ON CONFLICT (team_id) DO UPDATE SET text = excluded.text, path = excluded.path").run(teamId, next.text, next.path);
    return next;
  }
}

const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Reads the role file now. `roots` are the checkouts it may be in, the lead's own first; a relative
 * path is looked for in each in turn, and a file outside every one of them (also through a symlink) is refused.
 */
export function readRoleFile(path: string, roots: readonly string[]): LeadRoleFile {
  const none = (problem: string): LeadRoleFile => ({ content: null, resolved: null, problem });
  const real: string[] = [];
  for (const root of roots) {
    try {
      const r = realpathSync(root);
      if (!real.includes(r)) real.push(r);
    } catch {
      // A checkout that has gone is not somewhere to look.
    }
  }
  if (!real.length) return none(`${path} was not looked for: the office knows no checkout of the team to look in`);
  const candidates = isAbsolute(path) ? [path] : real.map((root) => resolve(root, path));
  let refused: string | null = null;
  for (const candidate of candidates) {
    let file: string;
    try {
      file = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!real.some((root) => inside(root, file))) {
      refused = `${path} is outside the team's checkouts, so the office does not read it`;
      continue;
    }
    try {
      if (!statSync(file).isFile()) {
        refused = `${file} is not a file`;
        continue;
      }
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(ROLE_FILE_MAX_BYTES + 1);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        const cut = read > ROLE_FILE_MAX_BYTES;
        const content = buffer.subarray(0, Math.min(read, ROLE_FILE_MAX_BYTES)).toString("utf8").replace(/\0/g, "").trim();
        if (!content) return { content: null, resolved: file, problem: `${file} is empty` };
        return { content, resolved: file, problem: cut ? `${file} is longer than ${ROLE_FILE_MAX_BYTES / 1024} KB: only the first ${ROLE_FILE_MAX_BYTES / 1024} KB are delivered` : null };
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      refused = `${file} could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`;
    }
  }
  return none(refused ?? `${path} was not found in ${real.join(", ")}`);
}

/** What the team's panel shows about the role file: null when all is well or no file is set. */
export function roleFileProblem(setting: LeadRoleSetting, roots: readonly string[]): string | null {
  return setting.path ? readRoleFile(setting.path, roots).problem : null;
}

/**
 * What every lead is told when it starts: the delegation rule, then its team's role (the text, then
 * the file as it is now). A file that cannot be read is said to the lead, never skipped silently.
 * The same words go in a new project's system prompt, a takeover brief, a made-lead notice and `inbox team`.
 */
export function leadBrief(teamName: string, setting: LeadRoleSetting & { byDefault?: true }, roots: readonly string[]): string {
  const lines = [DELEGATION_RULE];
  if (setting.text) lines.push(`${teamName}'s lead role, ${setting.byDefault ? "the office's default for a standing team until the founder sets one" : "set by the founder"}: ${setting.text}`);
  if (setting.path) {
    const file = readRoleFile(setting.path, roots);
    if (file.content) {
      lines.push(`${teamName}'s lead role file ${setting.path}, read just now from ${file.resolved}${file.problem ? ` (${file.problem})` : ""}:`, "--- begin lead role ---", file.content, "--- end lead role ---");
    } else {
      lines.push(`The office could not give you ${teamName}'s lead role file ${setting.path}: ${file.problem}. Work from the rest of this brief, and say so to the founder in your next \`inbox say founder\`.`);
    }
  }
  return lines.join("\n");
}
