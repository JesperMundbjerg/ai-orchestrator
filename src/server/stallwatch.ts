// Watches the office's own event loop. A block (the loop not answering for over a second, such as
// a synchronous git call on a loaded machine) is found by a timer that arrives late, and a rolling CPU
// profile of the last window says what ran. A window's profile is kept on disk only when a block
// happened in it, at most `keep` of them, so a calm office writes nothing and a stalled one can be
// profiled without pausing it. No model, no network; everything stays in the data directory.

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Hotspot {
  /** Where the loop was busy: the function, then the callers it was reached through. */
  fn: string;
  via: string;
  where: string;
  ms: number;
}

export interface Block {
  /** When the loop stopped answering. */
  at: string;
  ms: number;
  /** The window's `.cpuprofile` in the stalls folder, while it is kept. */
  profile: string | null;
  hotspots: Hotspot[];
}

export interface Window {
  at: string;
  maxMs: number;
  p99Ms: number;
  meanMs: number;
}

export interface StallState {
  enabled: true;
  startedAt: string;
  thresholdMs: number;
  windowMs: number;
  profiling: boolean;
  /** Newest first. */
  blocks: Block[];
  /** The last windows' loop delay, newest first. */
  windows: Window[];
}

export interface StallOptions {
  dir: string;
  thresholdMs?: number;
  windowMs?: number;
  keep?: number;
  tickMs?: number;
  log?: (line: string) => void;
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

const BLOCKS_KEPT = 100;
const WINDOWS_KEPT = 20;
const HOTSPOTS = 5;
const IGNORED = new Set(["(idle)", "(program)", "(root)"]);

export class StallWatch {
  private dir: string;
  private thresholdMs: number;
  private windowMs: number;
  private keep: number;
  private tickMs: number;
  private log: (line: string) => void;
  private startedAt = new Date().toISOString();
  private blocks: Block[] = [];
  private windows: Window[] = [];
  private histogram: ReturnType<typeof monitorEventLoopDelay> = monitorEventLoopDelay({ resolution: 10 });
  private session: Session | null = null;
  private profiling = false;
  private ticker: NodeJS.Timeout | null = null;
  private roller: NodeJS.Timeout | null = null;
  private expected = 0;
  private windowStart = 0;
  private windowWall = 0;
  /** Blocks seen since the window began, with when each began on the loop's clock. */
  private inWindow: Array<{ block: Block; began: number }> = [];
  private stopped = false;

  constructor(options: StallOptions) {
    this.dir = options.dir;
    this.thresholdMs = options.thresholdMs ?? 1000;
    this.windowMs = options.windowMs ?? 30_000;
    this.keep = options.keep ?? 10;
    this.tickMs = options.tickMs ?? 100;
    this.log = options.log ?? ((line) => console.error(line));
  }

  async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.load();
    this.histogram.enable();
    await this.beginProfile();
    this.expected = performance.now() + this.tickMs;
    this.ticker = setInterval(() => this.check(), this.tickMs);
    this.ticker.unref();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.roller) clearTimeout(this.roller);
    this.histogram.disable();
    try { this.session?.disconnect(); } catch { /* already gone */ }
    this.session = null;
  }

  state(): StallState {
    return { enabled: true, startedAt: this.startedAt, thresholdMs: this.thresholdMs, windowMs: this.windowMs, profiling: this.profiling, blocks: this.blocks, windows: this.windows };
  }

  /** A tick that arrives much later than it was due means nothing else ran in between. */
  private check(): void {
    const now = performance.now();
    const late = now - this.expected;
    this.expected = now + this.tickMs;
    if (late < this.thresholdMs) return;
    const block: Block = { at: new Date(Date.now() - late).toISOString(), ms: Math.round(late), profile: null, hotspots: [] };
    this.inWindow.push({ block, began: now - late });
    this.blocks.unshift(block);
    this.blocks.length = Math.min(this.blocks.length, BLOCKS_KEPT);
    this.log(`stall: the office did not answer for ${block.ms} ms from ${block.at}`);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.roller = setTimeout(() => void this.roll().finally(() => this.schedule()), this.windowMs);
    this.roller.unref();
  }

  private async beginProfile(): Promise<void> {
    this.windowStart = performance.now();
    this.windowWall = Date.now();
    this.inWindow = [];
    if (!this.session) {
      try {
        this.session = new Session();
        this.session.connect();
        await this.session.post("Profiler.enable");
        await this.session.post("Profiler.setSamplingInterval", { interval: 2000 });
      } catch (err) {
        this.log(`stall watch: no CPU profile (${(err as Error).message}); blocks are still listed`);
        this.session = null;
        this.profiling = false;
        return;
      }
    }
    try {
      await this.session.post("Profiler.start");
      this.profiling = true;
    } catch (err) {
      this.log(`stall watch: no CPU profile (${(err as Error).message}); blocks are still listed`);
      this.profiling = false;
    }
  }

  /** Closes the window: its loop delay is recorded, its profile kept only if the loop was blocked in it. */
  private async roll(): Promise<void> {
    this.check();
    const h = this.histogram;
    const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
    this.windows.unshift({ at: new Date(this.windowWall).toISOString(), maxMs: ms(h.max), p99Ms: ms(h.percentile(99)), meanMs: ms(h.mean) });
    this.windows.length = Math.min(this.windows.length, WINDOWS_KEPT);
    h.reset();
    const blocked = this.inWindow;
    const startedAt = this.windowStart;
    let profile: CpuProfile | null = null;
    if (this.session && this.profiling) {
      try {
        profile = (await this.session.post("Profiler.stop")).profile as CpuProfile;
      } catch (err) {
        this.log(`stall watch: profile stop failed: ${(err as Error).message}`);
      }
      this.profiling = false;
    }
    await this.beginProfile();
    if (!blocked.length) return;
    try {
      if (profile) this.keepProfile(profile, blocked, startedAt);
    } catch (err) {
      this.log(`stall watch: could not keep the profile: ${(err as Error).message}`);
    }
    this.save();
  }

  private keepProfile(profile: CpuProfile, blocked: Array<{ block: Block; began: number }>, windowStart: number): void {
    const worst = Math.max(...blocked.map((b) => b.block.ms));
    const name = `${new Date(this.windowWallOf(blocked)).toISOString().replace(/[:.]/g, "-")}-${worst}ms.cpuprofile`;
    writeFileSync(join(this.dir, name), JSON.stringify(profile));
    for (const { block, began } of blocked) {
      block.profile = name;
      block.hotspots = hotspots(profile, (began - windowStart) * 1000, (began - windowStart + block.ms) * 1000);
    }
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".cpuprofile")).sort();
    for (const gone of files.slice(0, Math.max(0, files.length - this.keep))) {
      rmSync(join(this.dir, gone), { force: true });
      for (const b of this.blocks) if (b.profile === gone) b.profile = null;
    }
  }

  private windowWallOf(blocked: Array<{ block: Block }>): number {
    return Date.parse(blocked[blocked.length - 1]!.block.at);
  }

  private save(): void {
    try { writeFileSync(join(this.dir, "blocks.json"), JSON.stringify(this.blocks)); } catch { /* the list in memory still serves */ }
  }

  private load(): void {
    try {
      const kept = JSON.parse(readFileSync(join(this.dir, "blocks.json"), "utf8")) as Block[];
      const files = new Set(readdirSync(this.dir));
      this.blocks = kept.filter((b) => b && typeof b.ms === "number").map((b) => ({ ...b, profile: b.profile && files.has(b.profile) ? b.profile : null }));
    } catch { /* first run, or an unreadable list: start with none */ }
  }
}

/** The stacks that held the loop during [from, to] microseconds into the profile, longest first. */
export function hotspots(profile: CpuProfile, from: number, to: number): Hotspot[] {
  const { nodes, samples, timeDeltas } = profile;
  if (!samples || !timeDeltas) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const total = new Map<number, number>();
  let at = 0;
  for (let i = 0; i < samples.length; i++) {
    at += timeDeltas[i] ?? 0;
    const next = timeDeltas[i + 1] ?? 0;
    // Samples inside the block, a little widened: the timer and the profile clock start apart.
    if (at < from - 50_000 || at > to + 50_000) continue;
    const node = byId.get(samples[i]!);
    if (!node || IGNORED.has(node.callFrame.functionName)) continue;
    total.set(node.id, (total.get(node.id) ?? 0) + next);
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, HOTSPOTS).map(([id, micro]) => {
    const frame = byId.get(id)!.callFrame;
    const via: string[] = [];
    for (let up = parent.get(id); up !== undefined && via.length < 6; up = parent.get(up)) {
      const name = byId.get(up)?.callFrame.functionName;
      if (name && !IGNORED.has(name)) via.push(name);
    }
    return { fn: frame.functionName || "(anonymous)", via: via.join(" < "), where: frame.url ? `${frame.url}:${frame.lineNumber + 1}` : "(native)", ms: Math.round(micro / 1000) };
  });
}
