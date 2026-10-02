// The founder's subscription use: the limits' meters, and each agent's and team's tokens this week.
// Nothing here calls a model, and the only account call is Codex's usage read (codexaccount.ts). A meter is what the provider said in the
// headers of a reply an agent was already getting: Claude Code hands it to its statusline command
// (`inbox statusline`), Pi's extension forwards Codex's `x-codex-*` headers, and the codex CLI writes
// it into its rollout. Claude Code's own cache of its last `/usage` read (~/.claude.json) is the
// fallback, with its age. Tokens come from the session files each harness keeps, read a slice at a
// time in the background, so drawing the office never waits for a 2 GB folder.

import type { DatabaseSync } from "node:sqlite";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness, Team, UsageMeter, UsageShare, UsageView } from "../shared/types.ts";
import type { CrewPause } from "./crewtree.ts";
import type { OfficeNotices } from "./notices.ts";
import type { LimitReading } from "../shared/usage.ts";
import { CODEX_AUTH_PATH, fetchAccount, readCodexAccount, type AccountFetcher } from "./codexaccount.ts";

export type { LimitReading };

/** Whose limit a reply counted against: Claude Max, or ChatGPT through Codex. */
export type Provider = "claude" | "codex";
export type UsageWindow = UsageMeter["window"];

export interface UsageRoots {
  claude: string;
  codex: string;
  pi: string;
  /** Claude Code's own state file, which caches its last plan-usage read. */
  claudeJson: string;
}

export const USAGE_ROOTS: UsageRoots = {
  claude: join(homedir(), ".claude/projects"),
  codex: join(homedir(), ".codex/sessions"),
  pi: join(homedir(), ".pi/agent/sessions"),
  claudeJson: join(homedir(), ".claude.json"),
};

const WINDOW_MS: Record<UsageWindow, number> = { five_hour: 5 * 3600_000, week: 7 * 86400_000 };
const LABELS: Record<string, string> = {
  "claude.five_hour": "Claude 5-hour",
  "claude.week": "Claude week",
  "codex.five_hour": "Codex 5-hour",
  "codex.week": "Codex week",
};
/** Always shown, with no reading yet if need be; Codex's 5-hour meter only once a plan reports one. */
const ALWAYS = ["claude.five_hour", "claude.week", "codex.week"];

/** A reading older than this may be behind: use has moved since, or nobody has run to say. */
export const STALE_MS = 30 * 60_000;
/** A reading that says nothing new is written again only after this, so its age stays right. */
const REWRITE_MS = 60_000;
/** The founder's rule: Claude crew stop starting at this much of the 5-hour window. */
export const PAUSE_AT = 90;

/** Codex's account is asked for its limits this often (and once at start). */
export const ACCOUNT_EVERY_MS = 5 * 60_000;

/** The local sources (Claude Code's cache, the newest Codex rollout) are looked at again no sooner than this. */
const RECHECK_MS = 10_000;
/** The session folders are listed again no sooner than this. */
const RELIST_MS = 15_000;
/** How much of the session files one background step reads. */
const STEP_BYTES = 32 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
/** Files untouched for longer than this cannot hold this week's use. */
const HORIZON_MS = 8 * 86400_000;
const HOUR = 3600_000;

type Entry = Record<string, any>;

/** Tokens for a meter's own count, and a weight closer to what a limit charges: output costs most, a cache read little. */
interface Tally {
  tokens: number;
  weight: number;
}

function tally(input: number, cacheWrite: number, cacheRead: number, output: number): Tally {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const [i, w, r, o] = [n(input), n(cacheWrite), n(cacheRead), n(output)];
  return { tokens: i + w + o, weight: i + 1.25 * w + 0.1 * r + 5 * o };
}

/** One session file and what has been read of it. */
interface FileState {
  path: string;
  harness: Harness;
  sessionId: string;
  cwd: string | null;
  size: number;
  offset: number;
  /** Inside a line longer than a chunk, which is skipped. */
  skipping: boolean;
  /** Per provider and hour (epoch ms at the hour's start). */
  buckets: Map<string, Tally>;
  /** Claude Code writes a streamed reply once per content block, each with the same usage. */
  seen: Set<string>;
  /** Codex's running total, so a repeated token_count is not counted twice. */
  lastTotal: number;
}

const toIso = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) {
    const t = /^\d+(\.\d+)?$/.test(v) ? Number(v) : Date.parse(v);
    if (Number.isFinite(t) && t > 0) return new Date(/^\d+(\.\d+)?$/.test(v) && t < 1e12 ? t * 1000 : t).toISOString();
  }
  return null;
};

/** Codex names a window by its length, not by which of primary/secondary carries it: 300 minutes is the 5-hour one, 10080 the week. */
const windowOfMinutes = (m: unknown): UsageWindow | null => {
  const n = Number(m);
  return n > 0 && n <= 360 ? "five_hour" : n >= 9000 && n <= 11000 ? "week" : null;
};

/**
 * A meter at PAUSE_AT or more holds whatever its age, until its window resets (use only grows
 * until then, and a meter whose window has reset shows 0). Only a reading with no known reset is
 * trusted no longer than it is fresh, so it cannot hold for ever.
 */
const high = (m: UsageMeter | undefined): m is UsageMeter => !!m && m.usedPercent !== null && m.usedPercent >= PAUSE_AT && (m.resetsAt !== null || !m.stale);

const windowOf = (r: LimitReading): UsageWindow | null =>
  r.window === "five_hour" || r.window === "week" ? r.window : windowOfMinutes(r.windowMinutes);

export class Usage {
  private db: DatabaseSync;
  private now: () => Date;
  private roots: UsageRoots;
  private files = new Map<string, FileState>();
  private listedAt = 0;
  private checked = { claudeJson: 0, claudeJsonMtime: -1, codex: 0, codexPath: "", codexSize: -1 };
  private timer: NodeJS.Timeout | null = null;
  /** Where the Codex login is read from, and how the account is asked; tests replace both. */
  codexAccount: { authPath: string; fetcher: AccountFetcher } = { authPath: CODEX_AUTH_PATH, fetcher: fetchAccount };
  private accountTimer: NodeJS.Timeout | null = null;
  /** Said when a meter's reading changes. */
  onChange: () => void = () => {};

  constructor(db: DatabaseSync, now: () => Date = () => new Date(), roots: UsageRoots = USAGE_ROOTS) {
    this.db = db;
    this.now = now;
    this.roots = roots;
    db.exec(`CREATE TABLE IF NOT EXISTS usage_readings (
      meter TEXT PRIMARY KEY,
      used_percent REAL NOT NULL,
      resets_at TEXT,
      as_of TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_told (key TEXT PRIMARY KEY, at TEXT NOT NULL)`);
  }

  /** Reads the session files in the background: quickly while catching up, then every few seconds. */
  start(): void {
    const step = () => {
      let behind = false;
      try {
        behind = this.scan(STEP_BYTES);
      } catch (err) {
        console.error(`usage: ${(err as Error).message}`);
      }
      this.timer = setTimeout(step, behind ? 250 : 5000);
      this.timer.unref();
    };
    step();
    void this.readAccount();
    this.accountTimer = setInterval(() => void this.readAccount(), ACCOUNT_EVERY_MS);
    this.accountTimer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.accountTimer) clearInterval(this.accountTimer);
    this.accountTimer = null;
  }

  /** Asks the Codex account for its limits, as a reading made now (so it wins over an older one). Quiet when it cannot. */
  async readAccount(): Promise<boolean> {
    const at = this.now();
    const readings = await readCodexAccount(this.codexAccount.authPath, this.codexAccount.fetcher, at.getTime());
    return readings.length > 0 && this.record("codex", readings, "codex-account", at);
  }

  /**
   * Keeps what a source said. A reading older than the one kept is ignored, so Claude Code's cache
   * never overwrites the statusline; one that says nothing new only refreshes its age now and then.
   * True when what a meter shows has changed.
   */
  record(provider: Provider, readings: LimitReading[], source: string, asOf: Date = this.now()): boolean {
    let changed = false;
    for (const r of readings) {
      const window = windowOf(r);
      const used = Number(r.usedPercent);
      if (!window || !Number.isFinite(used)) continue;
      const meter = `${provider}.${window}`;
      const percent = Math.round(Math.min(100, Math.max(0, used)) * 10) / 10;
      const resetsAt = toIso(r.resetsAt);
      const kept = this.db.prepare("SELECT * FROM usage_readings WHERE meter = ?").get(meter) as Entry | undefined;
      if (kept && Date.parse(kept.as_of) > asOf.getTime()) continue;
      const same = kept && kept.used_percent === percent && kept.resets_at === resetsAt;
      if (same && asOf.getTime() - Date.parse(kept.as_of) < REWRITE_MS) continue;
      this.db.prepare(`INSERT INTO usage_readings (meter, used_percent, resets_at, as_of, source) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (meter) DO UPDATE SET used_percent = excluded.used_percent, resets_at = excluded.resets_at, as_of = excluded.as_of, source = excluded.source`)
        .run(meter, percent, resetsAt, asOf.toISOString(), source);
      if (!same) changed = true;
    }
    if (changed) this.onChange();
    return changed;
  }

  /** Every meter as it stands now. A window that has reset since its reading shows empty, as not yet confirmed. */
  meters(): UsageMeter[] {
    this.readLocal();
    const rows = new Map((this.db.prepare("SELECT * FROM usage_readings").all() as Entry[]).map((r) => [String(r.meter), r]));
    const ids = [...ALWAYS, ...[...rows.keys()].filter((id) => !ALWAYS.includes(id) && LABELS[id])];
    return ids.map((id) => this.meter(id, rows.get(id)));
  }

  private meter(id: string, row: Entry | undefined): UsageMeter {
    const window = id.endsWith(".five_hour") ? "five_hour" : "week";
    const base = { id, label: LABELS[id] ?? id, window } as const;
    if (!row) return { ...base, usedPercent: null, resetsAt: null, asOf: null, stale: false };
    const now = this.now().getTime();
    let resetsAt = row.resets_at ? Date.parse(String(row.resets_at)) : NaN;
    if (Number.isFinite(resetsAt) && resetsAt <= now) {
      // The window has started again since: it is empty but for what nobody has reported yet. The week
      // keeps its weekday and hour; a 5-hour window starts with the next use, so its end is not known.
      while (resetsAt <= now) resetsAt += WINDOW_MS[window];
      return { ...base, usedPercent: 0, resetsAt: window === "week" ? new Date(resetsAt).toISOString() : null, asOf: String(row.as_of), stale: true };
    }
    return {
      ...base,
      usedPercent: Number(row.used_percent),
      resetsAt: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null,
      asOf: String(row.as_of),
      stale: now - Date.parse(String(row.as_of)) > STALE_MS,
    };
  }

  /**
   * The founder's rule for the crew guide: Claude's 5-hour window, when a reading puts it at
   * PAUSE_AT or more, held until its reset whatever its age. Null otherwise, including with no
   * reading at all.
   */
  claudePause(): { percent: number; resetsAt: string | null } | null {
    const m = this.meters().find((x) => x.id === "claude.five_hour");
    return high(m) ? { percent: m.usedPercent!, resetsAt: m.resetsAt } : null;
  }

  /**
   * The mirror image, for Pi's Codex: any Codex meter (the week, and the 5-hour window when a plan
   * reports one) at PAUSE_AT or more, held as Claude's is. When several are high it holds until the
   * last of them resets.
   */
  codexPause(): { meter: UsageMeter; percent: number; resetsAt: string | null } | null {
    const over = this.meters().filter((m) => m.id.startsWith("codex.") && high(m));
    if (!over.length) return null;
    const last = (m: UsageMeter) => (m.resetsAt ? Date.parse(m.resetsAt) : Infinity);
    const worst = over.reduce((a, b) => (last(b) > last(a) || (last(b) === last(a) && b.usedPercent! > a.usedPercent!) ? b : a));
    // With any high meter's end unknown, so is when it starts again.
    return { meter: worst, percent: worst.usedPercent!, resetsAt: over.some((m) => !m.resetsAt) ? null : worst.resetsAt };
  }

  /**
   * The crew guide's pause, in words a lead reads: why a harness is paused, and until when. Codex's
   * limit pauses Pi (new crew get the Claude backups); Claude's pauses Claude Code. When both are
   * high Claude is kept, the founder's default, and its 5-hour window is also the one that ends sooner.
   */
  crewPause(): CrewPause | null {
    const time = (at: string | null, opts: Intl.DateTimeFormatOptions, tail: string) => (at ? `, until ${new Date(at).toLocaleString("en-GB", opts)}${tail}` : "");
    const x = this.codexPause();
    if (x) {
      const week = x.meter.window === "week";
      return { harness: "pi", why: `the founder's ${week ? "weekly" : "5-hour"} Codex use is ${Math.round(x.percent)}%${time(x.resetsAt, { ...(week ? { weekday: "short" as const } : {}), hour: "2-digit", minute: "2-digit" }, " when its window starts again")}` };
    }
    const p = this.claudePause();
    if (!p) return null;
    return { harness: "claude", why: `the founder's 5-hour Claude use is ${Math.round(p.percent)}%${time(p.resetsAt, { hour: "2-digit", minute: "2-digit" }, " when its window starts again")}` };
  }

  /**
   * When Claude's 5-hour window and Codex are both at PAUSE_AT or more, the crew guide keeps Claude
   * Code (see crewPause): Pi would meet Codex's limit, which resets later. The founder is told once
   * per Claude pause, since new crew may stop at Claude's limit soon. Only under Mix, the one switch
   * where the guide steers by limits. True when a notice was recorded.
   */
  tellFounder(notices: OfficeNotices, mixed: boolean): boolean {
    if (!mixed) return false;
    const pause = this.claudePause();
    const codex = this.codexPause();
    if (!pause || !codex) return false;
    const key = `claude-paused-codex-near:${pause.resetsAt ?? codex.resetsAt ?? "unknown"}`;
    const time = (at: string | null, opts: Intl.DateTimeFormatOptions) => (at ? new Date(at).toLocaleString("en-GB", opts) : null);
    const claudeUntil = time(pause.resetsAt, { hour: "2-digit", minute: "2-digit" });
    const codexUntil = time(codex.resetsAt, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const at = this.now().getTime();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const told = this.db.prepare("INSERT OR IGNORE INTO usage_told (key, at) VALUES (?, ?)").run(key, new Date(at).toISOString()).changes > 0;
      if (told) notices.record("Claude and Codex both near their limits",
        `Your 5-hour Claude use is ${Math.round(pause.percent)}%${claudeUntil ? ` (until ${claudeUntil})` : ""} and Codex's ${codex.meter.window === "week" ? "week" : "5-hour window"} is at ${Math.round(codex.percent)}%${codexUntil ? ` (it resets ${codexUntil})` : ""}. The crew guide keeps Claude Code, which starts again sooner, so new crew may stop at its limit soon.`, [], at);
      this.db.exec("COMMIT");
      return told;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Claude Code's cache of its last `/usage` read, and the newest Codex rollout's latest limits. */
  private readLocal(): void {
    const now = this.now().getTime();
    if (now - this.checked.claudeJson >= RECHECK_MS) {
      this.checked.claudeJson = now;
      try {
        const mtime = statSync(this.roots.claudeJson).mtimeMs;
        if (mtime !== this.checked.claudeJsonMtime) {
          this.checked.claudeJsonMtime = mtime;
          const cached = (JSON.parse(readFileSync(this.roots.claudeJson, "utf8")) as Entry).cachedUsageUtilization as Entry | undefined;
          const u = cached?.utilization as Entry | undefined;
          if (u && typeof cached!.fetchedAtMs === "number") {
            const readings: LimitReading[] = [];
            if (typeof u.five_hour?.utilization === "number") readings.push({ window: "five_hour", usedPercent: u.five_hour.utilization, resetsAt: u.five_hour.resets_at });
            if (typeof u.seven_day?.utilization === "number") readings.push({ window: "week", usedPercent: u.seven_day.utilization, resetsAt: u.seven_day.resets_at });
            this.record("claude", readings, "claude-code-cache", new Date(cached!.fetchedAtMs));
          }
        }
      } catch {
        // no Claude Code here, or the file is being written: tried again later
      }
    }
    if (now - this.checked.codex >= RECHECK_MS) {
      this.checked.codex = now;
      const path = this.newestRollout();
      let size = -1;
      try {
        if (path) size = statSync(path).size;
      } catch {
        // gone meanwhile
      }
      if (path && (path !== this.checked.codexPath || size !== this.checked.codexSize)) {
        this.checked.codexPath = path;
        this.checked.codexSize = size;
        const found = lastRolloutLimits(path);
        if (found) this.record("codex", found.readings, "codex-rollout", found.asOf);
      }
    }
  }

  private newestRollout(): string | null {
    let best: { path: string; mtime: number } | null = null;
    for (const year of list(this.roots.codex).reverse().slice(0, 1)) {
      for (const month of list(join(this.roots.codex, year)).reverse().slice(0, 2)) {
        for (const day of list(join(this.roots.codex, year, month)).reverse().slice(0, 3)) {
          const dir = join(this.roots.codex, year, month, day);
          for (const f of list(dir)) {
            if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
            try {
              const mtime = statSync(join(dir, f)).mtimeMs;
              if (!best || mtime > best.mtime) best = { path: join(dir, f), mtime };
            } catch {
              // gone meanwhile
            }
          }
        }
      }
    }
    return best?.path ?? null;
  }

  /**
   * Reads up to `budget` bytes more of the session files touched in the last week. True while there
   * is more to read. Lines are parsed only when they can hold usage.
   */
  scan(budget = Infinity): boolean {
    const now = this.now().getTime();
    if (now - this.listedAt >= RELIST_MS) {
      this.listedAt = now;
      this.relist(now);
    }
    let left = budget;
    for (const f of this.files.values()) {
      if (left <= 0) return true;
      left -= this.read(f, left);
    }
    return left <= 0 && [...this.files.values()].some((f) => f.offset < f.size);
  }

  private relist(now: number): void {
    const found: Array<{ path: string; harness: Harness; sessionId: string }> = [];
    // Claude Code: <root>/<project>/<session>.jsonl, and its sub-agents' in <session>/subagents/, counted to the session.
    for (const project of list(this.roots.claude)) {
      const dir = join(this.roots.claude, project);
      for (const f of list(dir)) {
        if (f.endsWith(".jsonl")) found.push({ path: join(dir, f), harness: "claude", sessionId: f.slice(0, -6) });
        else for (const sub of list(join(dir, f, "subagents"))) if (sub.endsWith(".jsonl")) found.push({ path: join(dir, f, "subagents", sub), harness: "claude", sessionId: f });
      }
    }
    // Pi: its session is the file's path.
    for (const dir of list(this.roots.pi)) for (const f of list(join(this.roots.pi, dir))) if (f.endsWith(".jsonl")) found.push({ path: join(this.roots.pi, dir, f), harness: "pi", sessionId: join(this.roots.pi, dir, f) });
    // Codex: <root>/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
    for (const year of list(this.roots.codex)) for (const month of list(join(this.roots.codex, year))) for (const day of list(join(this.roots.codex, year, month))) {
      const dir = join(this.roots.codex, year, month, day);
      for (const f of list(dir)) {
        const thread = f.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1];
        if (thread) found.push({ path: join(dir, f), harness: "codex", sessionId: thread });
      }
    }
    const keep = new Set<string>();
    for (const f of found) {
      let st;
      try {
        st = statSync(f.path);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > HORIZON_MS) continue;
      keep.add(f.path);
      const known = this.files.get(f.path);
      if (known) {
        if (st.size < known.offset) this.files.set(f.path, this.fresh(f, st.size)); // rewritten: read again
        else known.size = st.size;
      } else this.files.set(f.path, this.fresh(f, st.size));
    }
    for (const path of this.files.keys()) if (!keep.has(path)) this.files.delete(path);
  }

  private fresh(f: { path: string; harness: Harness; sessionId: string }, size: number): FileState {
    return { ...f, cwd: null, size, offset: 0, skipping: false, buckets: new Map(), seen: new Set(), lastTotal: -1 };
  }

  /** Reads whole lines from where it stopped, at most `budget` bytes; returns the bytes read. */
  private read(f: FileState, budget: number): number {
    if (f.offset >= f.size) return 0;
    let fd: number;
    try {
      fd = openSync(f.path, "r");
    } catch {
      return 0;
    }
    let total = 0;
    try {
      f.size = fstatSync(fd).size;
      while (f.offset < f.size && total < budget) {
        const want = Math.min(CHUNK, f.size - f.offset);
        const buffer = Buffer.alloc(want);
        const got = readSync(fd, buffer, 0, want, f.offset);
        if (!got) break;
        total += got;
        let start = 0;
        if (f.skipping) {
          const nl = buffer.indexOf(10);
          if (nl < 0 || nl >= got) {
            f.offset += got;
            continue;
          }
          f.skipping = false;
          start = nl + 1;
        }
        const end = buffer.lastIndexOf(10, got - 1);
        if (end < start) {
          // No line ends in a whole chunk: a giant line, skipped. At the file's end it is still being written.
          if (got === CHUNK) {
            f.skipping = true;
            f.offset += got;
            continue;
          }
          break;
        }
        for (const line of buffer.toString("utf8", start, end).split("\n")) this.line(f, line);
        f.offset += end + 1;
      }
    } finally {
      closeSync(fd);
    }
    return total;
  }

  private line(f: FileState, line: string): void {
    if (f.harness === "claude") {
      if (!line.includes('"usage"')) return;
      const e = parse(line);
      const m = e?.message as Entry | undefined;
      if (e?.type !== "assistant" || !m?.usage) return;
      const key = `${m.id ?? ""}|${e.requestId ?? ""}`;
      if (key !== "|") {
        if (f.seen.has(key)) return;
        f.seen.add(key);
      }
      if (typeof e.cwd === "string") f.cwd ??= e.cwd;
      const u = m.usage as Entry;
      this.add(f, "claude", Date.parse(String(e.timestamp)), tally(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens));
    } else if (f.harness === "pi") {
      if (f.cwd === null && line.includes('"session"')) {
        const e = parse(line);
        if (e?.type === "session" && typeof e.cwd === "string") f.cwd = e.cwd;
      }
      if (!line.includes('"usage"')) return;
      const e = parse(line);
      const m = e?.message as Entry | undefined;
      if (e?.type !== "message" || m?.role !== "assistant" || !m.usage) return;
      // Which subscription the reply counted against: Codex through ChatGPT, or Claude.
      const provider: Provider | null = m.provider === "openai-codex" ? "codex" : m.provider === "anthropic" ? "claude" : null;
      if (!provider) return;
      const u = m.usage as Entry;
      this.add(f, provider, typeof m.timestamp === "number" ? m.timestamp : Date.parse(String(e.timestamp)), tally(u.input, u.cacheWrite, u.cacheRead, u.output));
    } else {
      if (f.cwd === null && line.includes('"session_meta"')) {
        const e = parse(line);
        if (e?.type === "session_meta" && typeof e.payload?.cwd === "string") f.cwd = e.payload.cwd;
      }
      if (!line.includes('"token_count"')) return;
      const e = parse(line);
      const info = e?.payload?.info as Entry | undefined;
      const last = info?.last_token_usage as Entry | undefined;
      if (e?.payload?.type !== "token_count" || !last) return;
      const sum = Number(info!.total_token_usage?.total_tokens);
      if (Number.isFinite(sum)) {
        if (sum === f.lastTotal) return;
        f.lastTotal = sum;
      }
      const cached = Number(last.cached_input_tokens) || 0;
      this.add(f, "codex", Date.parse(String(e.timestamp)), tally((Number(last.input_tokens) || 0) - cached, last.cache_write_input_tokens, cached, last.output_tokens));
    }
  }

  private add(f: FileState, provider: Provider, at: number, t: Tally): void {
    if (!Number.isFinite(at)) return;
    const key = `${provider}|${at - (at % HOUR)}`;
    const b = f.buckets.get(key) ?? { tokens: 0, weight: 0 };
    b.tokens += t.tokens;
    b.weight += t.weight;
    f.buckets.set(key, b);
  }

  /**
   * Each agent's and team's use in the current weekly windows, and the points of the weekly limits
   * it took: its part of a provider's weighted tokens this week, times that provider's weekly meter.
   * A session is an agent's when it is the agent's current session, or the one agent of its harness
   * in that folder; otherwise its folder's team still counts it.
   */
  view(agents: Array<{ id: string; harness: Harness; cwd: string | null; sessionId: string | null; teamId: string | null }>, teams: Team[]): UsageView {
    const meters = this.meters();
    const now = this.now().getTime();
    const week = new Map<Provider, { since: number; percent: number | null }>();
    for (const p of ["claude", "codex"] as const) {
      const m = meters.find((x) => x.id === `${p}.week`);
      const resets = m?.resetsAt ? Date.parse(m.resetsAt) : NaN;
      const since = Number.isFinite(resets) ? resets - WINDOW_MS.week : now - WINDOW_MS.week;
      // A reading from before this window started (it has reset since) says nothing to scale by.
      week.set(p, { since: since - (since % HOUR), percent: m?.usedPercent != null && m.asOf && Date.parse(m.asOf) >= since ? m.usedPercent : null });
    }
    const bySession = new Map(agents.filter((a) => a.sessionId).map((a) => [`${a.harness}:${a.sessionId}`, a]));
    const byFolder = new Map<string, Array<(typeof agents)[number]>>();
    for (const a of agents) if (a.cwd) byFolder.set(`${a.harness}:${a.cwd}`, [...(byFolder.get(`${a.harness}:${a.cwd}`) ?? []), a]);
    const teamOf = (cwd: string | null): string | null => {
      if (!cwd) return null;
      let best: { id: string; length: number } | null = null;
      for (const t of teams) for (const p of [t.path, ...t.worktrees]) {
        if (p && (cwd === p || cwd.startsWith(`${p}/`)) && (!best || p.length > best.length)) best = { id: t.id, length: p.length };
      }
      return best?.id ?? null;
    };
    const totals = new Map<Provider, number>();
    type Sum = { tokens: number; weight: Map<Provider, number> };
    const agentSums = new Map<string, Sum>();
    const teamSums = new Map<string, Sum>();
    const addTo = (sums: Map<string, Sum>, id: string, p: Provider, b: Tally) => {
      const s = sums.get(id) ?? { tokens: 0, weight: new Map() };
      s.tokens += b.tokens;
      s.weight.set(p, (s.weight.get(p) ?? 0) + b.weight);
      sums.set(id, s);
    };
    for (const f of this.files.values()) {
      const folder = f.cwd ? byFolder.get(`${f.harness}:${f.cwd}`) : undefined;
      const agent = bySession.get(`${f.harness}:${f.sessionId}`) ?? (folder?.length === 1 ? folder[0] : undefined);
      const team = agent?.teamId ?? teamOf(f.cwd);
      for (const [key, b] of f.buckets) {
        const [p, hour] = key.split("|") as [Provider, string];
        if (Number(hour) < week.get(p)!.since) continue;
        totals.set(p, (totals.get(p) ?? 0) + b.weight);
        if (agent) addTo(agentSums, agent.id, p, b);
        if (team) addTo(teamSums, team, p, b);
      }
    }
    const share = (s: Sum): UsageShare => {
      let points: number | null = null;
      const parts: UsageShare["parts"] = [];
      for (const [p, w] of s.weight) {
        const { percent } = week.get(p)!;
        const total = totals.get(p) ?? 0;
        if (percent === null || !total) continue;
        const part = (w / total) * percent;
        points = (points ?? 0) + part;
        parts.push({ meter: `${p}.week`, share: Math.round(part * 10) / 10 });
      }
      return { tokens: s.tokens, share: points === null ? null : Math.round(points * 10) / 10, parts };
    };
    return {
      meters,
      agents: Object.fromEntries([...agentSums].map(([id, s]) => [id, share(s)])),
      teams: Object.fromEntries([...teamSums].map(([id, s]) => [id, share(s)])),
    };
  }
}

/** The latest limits in a Codex rollout, from the end back. */
export function lastRolloutLimits(path: string): { readings: LimitReading[]; asOf: Date } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= (start ? 1 : 0); i--) {
      if (!lines[i]!.includes('"rate_limits"')) continue;
      const e = parse(lines[i]!);
      const limits = e?.payload?.rate_limits as Entry | undefined;
      if (e?.payload?.type !== "token_count" || !limits) continue;
      const readings: LimitReading[] = [];
      for (const w of [limits.primary, limits.secondary] as Entry[]) {
        if (w && typeof w.used_percent === "number") readings.push({ usedPercent: w.used_percent, windowMinutes: w.window_minutes, resetsAt: w.resets_at ?? null });
      }
      const asOf = new Date(String(e.timestamp));
      if (readings.length && Number.isFinite(asOf.getTime())) return { readings, asOf };
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function parse(line: string): Entry | null {
  try {
    return JSON.parse(line) as Entry;
  } catch {
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

