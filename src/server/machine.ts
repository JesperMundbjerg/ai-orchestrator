// What agents leave running on the machine: headless browsers (a script's or a dev server's
// probe) that nobody closed. Every 15 s the process list is read and each browser is grouped with
// its child processes (pages, GPU, network), summed and attributed to a project by the working
// folder of the process that started it. The office shows them when together they use a lot, or
// one outlives its owner's work, and tells the project's lead once. Nothing is ever killed
// automatically: Close is the founder's click, and only a listed browser can be closed.

import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { HeadlessBrowser, MachineState, WorldState } from "../shared/types.ts";
import { InboxError } from "./inbox.ts";

const run = promisify(execFile);

export const MACHINE_POLL_MS = 15_000;
/** Headless browsers together above this many percent of a core… */
export const HOT_CPU = 150;
/** …for this long are a warning. */
export const HOT_MS = 60_000;
/** A browser whose project nobody has worked on for this long was probably forgotten. */
export const FORGOTTEN_MS = 20 * 60_000;
/** More browsers than this at once is a warning by itself. */
export const MANY = 5;
/** A browser flagged this long is worth telling its project's lead about… */
export const TELL_AFTER_MS = 3 * 60_000;
/** …but a project hears about its browsers at most this often. */
export const TELL_EVERY_MS = 15 * 60_000;
/** While browsers are hot, one using at least this much is one of the reasons. */
const HOT_SHARE = 30;

export interface Proc {
  pid: number;
  ppid: number;
  /** Percent of one core. */
  cpu: number;
  rssKb: number;
  /** Seconds since it started. */
  elapsed: number;
  command: string;
}

/** `ps -o pid=,ppid=,pcpu=,rss=,etime=,command=` output, one process a line. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+([\d:-]+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]!.replace(",", ".")), rssKb: Number(m[4]), elapsed: elapsedSeconds(m[5]!), command: m[6]!.trim() });
  }
  return procs;
}

/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function elapsedSeconds(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = rest!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86_400 + h * 3600 + m * 60 + s;
}

/** The executable of a command line: the part before its first flag, since a path may have spaces in it. */
function executable(command: string): string {
  const path = command.split(/\s+-/)[0]!.trim();
  return path.slice(path.lastIndexOf("/") + 1);
}

const BROWSER = /^(chrome-headless-shell|headless_shell|chrome|chromium|chromium-browser|google chrome( for testing)?|google-chrome|msedge|microsoft edge|firefox|firefox-bin)$/i;
const HELPER = /--type=|\s-contentproc\b/;
const AUTOMATED = /--headless\b|\s-headless\b|playwright|puppeteer/i;

/**
 * A browser a program started, rather than one you use: a headless build, or a browser run with
 * `--headless` or a Playwright or Puppeteer profile. A helper process (a page, the GPU) is part of one.
 */
export function isAutomatedBrowser(command: string): boolean {
  const exe = executable(command);
  const base = exe.replace(/ Helper.*$/, "");
  if (!BROWSER.test(base)) return false;
  return /headless/i.test(base) || AUTOMATED.test(command);
}

/** A page's process: a renderer that is not an extension's, or a Firefox tab. */
function isPage(command: string): boolean {
  return (/--type=renderer\b/.test(command) && !/--extension-process\b/.test(command)) || /\s-contentproc\b.*\btab\b/.test(command);
}

export interface BrowserTree {
  pid: number;
  ppid: number;
  pids: number[];
  cpu: number;
  rssKb: number;
  pages: number;
  elapsed: number;
  command: string;
}

/**
 * Each automated browser's main process with everything under it. A root is a browser process
 * that is not a helper and whose parent is not itself a browser.
 */
export function browserTrees(procs: Proc[]): BrowserTree[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, Proc[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const roots = procs.filter((p) => isAutomatedBrowser(p.command) && !HELPER.test(p.command) && !(byPid.get(p.ppid) && isAutomatedBrowser(byPid.get(p.ppid)!.command)));
  return roots.map((root) => {
    const all: Proc[] = [];
    const stack = [root];
    while (stack.length) {
      const p = stack.pop()!;
      if (all.includes(p)) continue;
      all.push(p);
      stack.push(...(children.get(p.pid) ?? []));
    }
    return {
      pid: root.pid,
      ppid: root.ppid,
      pids: all.map((p) => p.pid),
      cpu: Math.round(all.reduce((s, p) => s + p.cpu, 0)),
      rssKb: all.reduce((s, p) => s + p.rssKb, 0),
      pages: all.filter((p) => isPage(p.command)).length,
      elapsed: root.elapsed,
      command: root.command,
    };
  });
}

/** A process and the ones that started it, nearest first, up to (not including) launchd or init. */
export function lineage(procs: Proc[], pid: number): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: number[] = [];
  for (let p = byPid.get(pid); p && p.pid > 1 && !out.includes(p.pid); p = byPid.get(p.ppid)) out.push(p.pid);
  return out;
}

export interface Place {
  path: string;
  teamId: string | null;
  agentId: string | null;
  label: string;
}

/** Where agents work: every project's worktree, and every agent's folder. */
export function placesOf(world: Pick<WorldState, "teams" | "agents">): Place[] {
  const teams = new Map(world.teams.map((t) => [t.id, t]));
  return [
    ...world.teams.flatMap((t) => (t.path ? [{ path: t.path, teamId: t.id, agentId: null, label: t.name }] : [])),
    ...world.agents.flatMap((a) => (a.cwd ? [{ path: a.cwd, teamId: a.teamId, agentId: a.id, label: (a.teamId && teams.get(a.teamId)?.name) || a.name }] : [])),
  ];
}

/** The place a folder is in: the deepest one containing it, a project before an agent's folder at the same depth. */
export function placeFor(cwd: string, places: Place[]): Place | null {
  const inside = places.filter((p) => cwd === p.path || cwd.startsWith(p.path.endsWith("/") ? p.path : `${p.path}/`));
  return inside.sort((a, b) => b.path.length - a.path.length || Number(Boolean(a.agentId)) - Number(Boolean(b.agentId)))[0] ?? null;
}

/** Whose browser it is: the nearest process that started it working in a known place. */
export function attribute(chain: number[], cwds: Map<number, string | null>, places: Place[]): Place | null {
  for (const pid of chain) {
    const cwd = cwds.get(pid);
    const place = cwd ? placeFor(cwd, places) : null;
    if (place) return place;
  }
  return null;
}

/** What is remembered about a browser between readings. */
interface Seen {
  /** Since when its project has had nobody working, while it runs. */
  ownerIdleSince: number | null;
  flaggedSince: number | null;
  told: boolean;
}

export interface Reading {
  trees: BrowserTree[];
  /** Per browser, whose it is. */
  owners: Map<number, Place | null>;
  /** Whether anyone on that project (or that agent) is working now. */
  busy: (place: Place | null) => boolean;
  now: number;
}

/**
 * The machine's state from one reading and what the earlier ones left: which browsers are
 * flagged and why, and the warning. Pure apart from updating `seen` and `hot`.
 */
export function assess(reading: Reading, seen: Map<number, Seen>, hot: { since: number | null }): MachineState {
  const { trees, owners, busy, now } = reading;
  const totalCpu = trees.reduce((s, t) => s + t.cpu, 0);
  hot.since = totalCpu > HOT_CPU ? hot.since ?? now : null;
  const isHot = hot.since !== null && now - hot.since >= HOT_MS;
  for (const pid of seen.keys()) if (!trees.some((t) => t.pid === pid)) seen.delete(pid);

  const count = new Map<string, number>();
  const browsers = trees.map((t): HeadlessBrowser => {
    const owner = owners.get(t.pid) ?? null;
    const s = seen.get(t.pid) ?? { ownerIdleSince: null, flaggedSince: null, told: false };
    seen.set(t.pid, s);
    const ownerBusy = busy(owner);
    s.ownerIdleSince = ownerBusy ? null : s.ownerIdleSince ?? now;
    const reasons: HeadlessBrowser["reasons"] = [];
    if (isHot && t.cpu >= HOT_SHARE) reasons.push("hot");
    if (s.ownerIdleSince !== null && now - s.ownerIdleSince >= FORGOTTEN_MS) reasons.push("forgotten");
    s.flaggedSince = reasons.length ? s.flaggedSince ?? now : null;
    const label = owner?.label ?? "Unknown";
    count.set(label, (count.get(label) ?? 0) + 1);
    return {
      pid: t.pid,
      label: `${label} browser`,
      project: owner?.label ?? null,
      teamId: owner?.teamId ?? null,
      cpu: t.cpu,
      memoryMb: Math.round(t.rssKb / 1024),
      pages: t.pages,
      processes: t.pids.length,
      ageSeconds: t.elapsed,
      ownerBusy,
      idleMinutes: s.ownerIdleSince === null ? 0 : Math.floor((now - s.ownerIdleSince) / 60_000),
      reasons,
    };
  });
  // Two browsers of one project are told apart by number.
  const nth = new Map<string, number>();
  for (const b of browsers) {
    const key = b.project ?? "Unknown";
    if (count.get(key)! < 2) continue;
    nth.set(key, (nth.get(key) ?? 0) + 1);
    b.label = `${key} browser ${nth.get(key)}`;
  }
  browsers.sort((a, b) => b.cpu - a.cpu);

  const why: Array<"hot" | "forgotten" | "many"> = [];
  if (isHot) why.push("hot");
  if (browsers.some((b) => b.reasons.includes("forgotten"))) why.push("forgotten");
  if (browsers.length > MANY) why.push("many");
  return { browsers, totalCpu, warning: why.length ? { why } : null, checkedAt: new Date(now).toISOString() };
}

/** What a project's lead is told about its browser: which, how much, and what to do. */
export function leadNote(b: HeadlessBrowser, flaggedMinutes: number): string {
  const what = [`${b.pages} ${b.pages === 1 ? "page" : "pages"}`, `${b.cpu}% CPU`, `${b.memoryMb} MB`, `running ${Math.round(b.ageSeconds / 60)} min`].join(", ");
  const why = b.reasons.includes("hot")
    ? `together with other headless browsers it has kept the founder's machine busy for ${flaggedMinutes}+ min`
    : `nobody on the project has been working for ${b.idleMinutes} min`;
  return [
    `A headless browser started from your project is still running (process ${b.pid}: ${what}), and ${why}.`,
    "If nobody uses it, close its pages and the browser (browser.close() in a finally), or stop the dev server or script that keeps it open; tell your crew the same.",
    "The founder can also close it from the office.",
  ].join(" ");
}

export interface MachineDeps {
  /** The process list, as `ps` prints it. */
  ps?: () => Promise<string>;
  /** The working folder of each process asked about (null when it cannot be read). */
  cwds?: (pids: number[]) => Promise<Map<number, string | null>>;
  /** Sends a signal to a process. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
}

/** The headless browsers running on this machine, read every 15 s while the service runs. */
export class Machine {
  private world: () => Pick<WorldState, "teams" | "agents">;
  private ps: () => Promise<string>;
  private readCwds: (pids: number[]) => Promise<Map<number, string | null>>;
  private kill: (pid: number, signal: NodeJS.Signals) => void;
  private now: () => number;
  /** Working folders, read once per process: a new browser costs one lookup for its lineage, a known one none. */
  private cwds = new Map<number, string | null>();
  private seen = new Map<number, Seen>();
  private hot = { since: null as number | null };
  /** When each project's lead was last told, so a project that keeps starting browsers is not told every time. */
  private toldTeam = new Map<string, number>();
  private last: MachineState = { browsers: [], totalCpu: 0, warning: null, checkedAt: new Date(0).toISOString() };
  private timer: NodeJS.Timeout | null = null;
  private reading: Promise<MachineState> | null = null;
  /** Called when what the office shows changes. */
  onChange: () => void = () => {};
  /** Tells a project's lead something; wired to the office's messages. */
  tellLead: (teamId: string, text: string) => boolean = () => false;

  constructor(world: () => Pick<WorldState, "teams" | "agents">, deps: MachineDeps = {}) {
    this.world = world;
    this.ps = deps.ps ?? readPs;
    this.readCwds = deps.cwds ?? readCwds;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    const tick = () => {
      void this.read().catch((err: Error) => console.error(`machine: ${err.message}`));
      this.timer = setTimeout(tick, MACHINE_POLL_MS);
      this.timer.unref();
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  state(): MachineState {
    return this.last;
  }

  /** Reads the process list once; concurrent callers share the reading. */
  read(): Promise<MachineState> {
    this.reading ??= this.readNow().finally(() => (this.reading = null));
    return this.reading;
  }

  private async readNow(): Promise<MachineState> {
    const procs = parsePs(await this.ps()).filter((p) => p.pid !== process.pid);
    const trees = browserTrees(procs);
    const alive = new Set(procs.map((p) => p.pid));
    for (const pid of this.cwds.keys()) if (!alive.has(pid)) this.cwds.delete(pid);
    const chains = new Map(trees.map((t) => [t.pid, lineage(procs, t.pid)]));
    const unknown = [...new Set([...chains.values()].flat())].filter((pid) => !this.cwds.has(pid));
    if (unknown.length) for (const [pid, cwd] of await this.readCwds(unknown)) this.cwds.set(pid, cwd);
    for (const pid of unknown) if (!this.cwds.has(pid)) this.cwds.set(pid, null);

    // The office is asked who works where only when there is a browser to place.
    const world = trees.length ? this.world() : { teams: [], agents: [] };
    const places = placesOf(world);
    const owners = new Map(trees.map((t) => [t.pid, attribute(chains.get(t.pid)!, this.cwds, places)]));
    const busy = (place: Place | null) =>
      !!place && world.agents.some((a) => a.status === "working" && (place.teamId ? a.teamId === place.teamId : a.id === place.agentId));
    const now = this.now();
    const before = fingerprint(this.last);
    this.last = assess({ trees, owners, busy, now }, this.seen, this.hot);
    this.tell(now);
    if (fingerprint(this.last) !== before) this.onChange();
    return this.last;
  }

  /** A browser flagged for a few minutes is its project's lead's to close: told once, and a project at most every 15 min. */
  private tell(now: number): void {
    for (const b of this.last.browsers) {
      const s = this.seen.get(b.pid);
      if (!b.teamId || !s || s.told || s.flaggedSince === null || now - s.flaggedSince < TELL_AFTER_MS) continue;
      const last = this.toldTeam.get(b.teamId);
      if (last !== undefined && now - last < TELL_EVERY_MS) continue;
      if (this.tellLead(b.teamId, leadNote(b, Math.round((now - s.flaggedSince) / 60_000)))) {
        s.told = true;
        this.toldTeam.set(b.teamId, now);
      }
    }
  }

  /**
   * Asks one headless browser to quit (SIGTERM to its main process; its pages go with it). The
   * process list is read again first, and anything that is not a headless browser's main process
   * in it is refused, so no other process can be signalled this way.
   */
  async close(pid: number): Promise<{ ok: true; closed: number }> {
    if (!Number.isInteger(pid) || pid <= 1) throw new InboxError(400, "name a browser by its process id");
    const state = await this.read();
    const browser = state.browsers.find((b) => b.pid === pid);
    if (!browser) throw new InboxError(409, `process ${pid} is not a headless browser the office lists`);
    try {
      this.kill(pid, "SIGTERM");
    } catch (err) {
      throw new InboxError(409, `could not close ${browser.label}: ${(err as Error).message}`);
    }
    return { ok: true, closed: pid };
  }
}

/** What the office shows, without the numbers that move every reading. */
function fingerprint(s: MachineState): string {
  return JSON.stringify([s.warning, s.browsers.map((b) => [b.pid, b.label, b.reasons, b.pages, Math.round(b.cpu / 25)])]);
}

async function readPs(): Promise<string> {
  // -ww: the whole command line, however long, so the flags that mark a headless browser are seen.
  const args = process.platform === "linux" ? ["-eww", "-o", "pid=,ppid=,pcpu=,rss=,etime=,args="] : ["-axww", "-o", "pid=,ppid=,pcpu=,rss=,etime=,command="];
  const { stdout } = await run("ps", args, { timeout: 5000, maxBuffer: 50_000_000 });
  return stdout;
}

/** Working folders: one `lsof` for all of them on macOS, `/proc` on Linux. */
async function readCwds(pids: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (process.platform === "linux") {
    await Promise.all(pids.map(async (pid) => out.set(pid, await readlink(`/proc/${pid}/cwd`).catch(() => null))));
    return out;
  }
  let text: string;
  try {
    ({ stdout: text } = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"], { timeout: 5000, maxBuffer: 5_000_000 }));
  } catch (err) {
    // lsof exits 1 when some processes could not be read, but still prints the rest.
    text = String((err as { stdout?: string }).stdout ?? "");
  }
  return parseLsofCwds(text);
}

/** `lsof -F pn` output: a `p<pid>` line, then its `n<path>`. */
export function parseLsofCwds(text: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}
