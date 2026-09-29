// The model an agent runs, read from the session file its own harness keeps: Claude Code's
// transcript, Pi's session file, Codex's rollout. It is what the harness wrote down, so nothing
// is guessed. It is read lazily when the office is drawn, and read again only once the file has
// grown, at most every few seconds: an agent that reports its model itself does not need it.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { modelLabel } from "../shared/models.ts";
import type { AgentModel, Harness } from "../shared/types.ts";

/** Where Claude Code and Codex keep their sessions. Pi's is the path herdr reports for it. */
export interface SessionRoots {
  claude: string;
  codex: string;
}

export const DEFAULT_ROOTS: SessionRoots = { claude: join(homedir(), ".claude/projects"), codex: join(homedir(), ".codex/sessions") };

/** A session file is looked at again no sooner than this. */
const RECHECK_MS = 10_000;
/** How much of a file's end is searched: the latest turn is near the end, a long tool output can push it back. */
const TAILS = [256 * 1024, 4 * 1024 * 1024];

type Entry = Record<string, any>;

const model = (id: unknown): AgentModel | null => (typeof id === "string" && id && !id.startsWith("<") ? { id, label: modelLabel(id) } : null);

/** Claude Code: the model of the latest reply ("<synthetic>" marks one Claude Code made up itself). */
export function claudeTranscriptModel(path: string): AgentModel | null {
  return lastInFile(path, '"assistant"', (e) => (e.type === "assistant" ? model(e.message?.model) : null));
}

/** Pi: a model change, or the model an assistant message was written by, whichever is latest. */
export function piSessionModel(path: string): AgentModel | null {
  return lastInFile(path, '"model', (e) => {
    if (e.type === "model_change" && typeof e.modelId === "string") return model(`${e.provider ? `${e.provider}/` : ""}${e.modelId}`);
    if (e.type === "message" && e.message?.role === "assistant" && typeof e.message.model === "string") return model(`${e.message.provider ? `${e.message.provider}/` : ""}${e.message.model}`);
    return null;
  });
}

/** Codex: the model of the latest turn. */
export function codexRolloutModel(path: string): AgentModel | null {
  return lastInFile(path, '"turn_context"', (e) => (e.type === "turn_context" ? model(e.payload?.model) : null));
}

/** Newest line first, the first one `pick` finds a model in. Lines without `hint` are not parsed. */
function lastInFile(path: string, hint: string, pick: (e: Entry) => AgentModel | null): AgentModel | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    for (const tail of TAILS) {
      const start = Math.max(0, size - tail);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      // The first line of a tail is usually cut short; it is only read when the tail is the whole file.
      for (let i = lines.length - 1; i >= (start ? 1 : 0); i--) {
        if (!lines[i]!.includes(hint)) continue;
        try {
          const found = pick(JSON.parse(lines[i]!) as Entry);
          if (found) return found;
        } catch {
          // an unreadable line is skipped
        }
      }
      if (!start) break;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A session id that names a file, never a path out of the harness's own folder. */
const SAFE_ID = /^[\w.-]+$/;

/** Finds each agent's session file and remembers what it said, by harness and session. */
export class SessionFiles {
  private roots: SessionRoots;
  private seen = new Map<string, { path: string | null; checked: number; size: number; model: AgentModel | null }>();

  constructor(roots: SessionRoots = DEFAULT_ROOTS) {
    this.roots = roots;
  }

  /** herdr reports no session for a Codex pane, so Codex is then found by the folder it runs in. */
  modelOf(harness: Harness, sessionId: string | null, now: number, cwd: string | null = null): AgentModel | null {
    if (harness !== "pi" && harness !== "codex" && harness !== "claude") return null;
    const byFolder = !sessionId && harness === "codex" && Boolean(cwd);
    if (!sessionId && !byFolder) return null;
    const key = byFolder ? `codex@${cwd}` : `${harness}:${sessionId}`;
    const before = this.seen.get(key);
    if (before && now - before.checked < RECHECK_MS) return before.model;
    // A folder's newest session can change (a new one starts), so it is looked for again each time.
    const path = byFolder ? this.newestRolloutIn(cwd!) : before?.path ?? this.find(harness, sessionId!);
    let size = -1;
    try {
      if (path) size = statSync(path).size;
    } catch {
      // gone: nothing to show
    }
    const found = size < 0 ? null : before && before.size === size ? before.model : this.read(harness, path!);
    this.seen.set(key, { path: size < 0 ? null : path, checked: now, size, model: found });
    return found;
  }

  private read(harness: Harness, path: string): AgentModel | null {
    return harness === "pi" ? piSessionModel(path) : harness === "codex" ? codexRolloutModel(path) : claudeTranscriptModel(path);
  }

  /** The most recently written Codex rollout that began in `cwd`, among the newest few. */
  private newestRolloutIn(cwd: string): string | null {
    const files: { path: string; mtime: number }[] = [];
    for (const year of list(this.roots.codex).reverse().slice(0, 1)) {
      for (const month of list(join(this.roots.codex, year)).reverse().slice(0, 2)) {
        for (const day of list(join(this.roots.codex, year, month)).reverse().slice(0, 3)) {
          const dir = join(this.roots.codex, year, month, day);
          for (const f of list(dir)) {
            if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
            try {
              files.push({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs });
            } catch {
              // gone meanwhile
            }
          }
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, 40).find((f) => this.rolloutCwd(f.path) === cwd)?.path ?? null;
  }

  private cwds = new Map<string, string | null>();

  /** Where a rollout began: the first line is its session_meta, which can be long (it holds the instructions). */
  private rolloutCwd(path: string): string | null {
    if (this.cwds.has(path)) return this.cwds.get(path)!;
    let cwd: string | null = null;
    try {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        const text = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
        const first = text.slice(0, text.indexOf("\n") < 0 ? undefined : text.indexOf("\n"));
        const entry = JSON.parse(first) as Entry;
        cwd = entry.type === "session_meta" && typeof entry.payload?.cwd === "string" ? entry.payload.cwd : null;
      } finally {
        closeSync(fd);
      }
    } catch {
      // unreadable, or not yet written whole: looked at again next time
      return null;
    }
    this.cwds.set(path, cwd);
    return cwd;
  }

  private find(harness: Harness, sessionId: string): string | null {
    // Pi's session is its file; herdr reports that path.
    if (harness === "pi") return isAbsolute(sessionId) && sessionId.endsWith(".jsonl") && existsSync(sessionId) ? sessionId : null;
    if (!SAFE_ID.test(sessionId)) return null;
    // Claude Code: <root>/<project folder>/<session id>.jsonl
    if (harness === "claude") {
      for (const dir of list(this.roots.claude)) {
        const path = join(this.roots.claude, dir, `${sessionId}.jsonl`);
        if (existsSync(path)) return path;
      }
      return null;
    }
    // Codex: <root>/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl, newest day first.
    for (const year of list(this.roots.codex).reverse()) {
      for (const month of list(join(this.roots.codex, year)).reverse()) {
        for (const day of list(join(this.roots.codex, year, month)).reverse()) {
          const dir = join(this.roots.codex, year, month, day);
          const file = list(dir).find((f) => f.startsWith("rollout-") && f.endsWith(`-${sessionId}.jsonl`));
          if (file) return join(dir, file);
        }
      }
    }
    return null;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
