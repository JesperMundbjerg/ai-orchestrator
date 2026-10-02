// Projector material without asking an agent to do anything. Git supplies names only;
// reviewExcerpt remains the single, fail-closed authority for paths and file contents.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ReviewExcerpt, Team, Work, WorldAgent } from "../shared/types.ts";
import { isReviewHelper } from "../shared/review.ts";
import { reviewExcerpt } from "./review-excerpt.ts";

const SLOT_MS = 20_000;
const LIST_TTL_MS = 60_000;
type FileLists = { root: string | null; changed: string[]; tracked: string[] };
type CacheEntry = { at: number; files: FileLists | null; pending: Promise<void> | null };
type Git = (cwd: string, args: string[]) => Promise<string>;
const git: Git = (cwd, args) => new Promise((accept, reject) => {
  execFile("git", args, { cwd, encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : accept(stdout));
});

// Key subdirectory and symlinked working directories to the same checkout without running
// git. Git still verifies the top asynchronously; a linked worktree's .git is a file.
function checkoutKey(cwd: string): string {
  let dir: string;
  try { dir = realpathSync(cwd); } catch { return resolve(cwd); }
  const original = dir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return original;
    dir = parent;
  }
}
const hash = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);
const names = (s: string) => s.split("\0").filter(Boolean);
const sorted = (xs: string[]) => [...new Set(xs)].sort();

export class ReviewFallback {
  private lists = new Map<string, CacheEntry>();
  private run: Git;
  private redraw?: () => void;
  private timer: NodeJS.Timeout | null = null;
  constructor(run: Git = git, redraw?: () => void) { this.run = run; this.redraw = redraw; }

  private nextSlot(now: number): void {
    if (!this.redraw || this.timer) return;
    // Ask viewers to refetch even when no tool events arrive. One lazy, unref'ed timer
    // per office, not per agent/poll; no delivery reaction and no work after viewers leave.
    this.timer = setTimeout(() => { this.timer = null; this.redraw?.(); }, SLOT_MS - (now % SLOT_MS));
    this.timer.unref();
  }

  /** Start one background refresh per checkout/minute. Snapshots never await this. */
  refresh(cwd: string, now = Date.now()): Promise<void> {
    const key = checkoutKey(cwd);
    let entry = this.lists.get(key);
    if (entry?.pending) return entry.pending;
    if (entry && now - entry.at < LIST_TTL_MS) return Promise.resolve();
    if (!entry) {
      if (this.lists.size >= 64) {
        const expired = [...this.lists].find(([, e]) => !e.pending && now - e.at >= LIST_TTL_MS);
        if (!expired) return Promise.resolve(); // Never evict a live throttle/in-flight job.
        this.lists.delete(expired[0]);
      }
      entry = { at: now, files: null, pending: null };
      this.lists.set(key, entry);
    }
    entry.at = now; // Failed refreshes are throttled too; stale lists remain usable.
    const current = entry;
    current.pending = this.load(key).then((files) => {
      current.files = files;
      current.pending = null;
      this.redraw?.(); // Cache became available: display-only SSE, never an agent reaction.
    }).catch(() => { current.pending = null; });
    return current.pending;
  }

  private async load(cwd: string): Promise<FileLists> {
    let root: string | null = null;
    try { root = (await this.run(cwd, ["rev-parse", "--show-toplevel"])).trim() || null; } catch { /* missing checkout */ }
    const read = async (...args: string[]) => { try { return root ? await this.run(root, args) : ""; } catch { return ""; } };
    // No fetch/network: use the locally known default branch, then conventional local names.
    const remote = (await read("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")).trim();
    const configured = (await read("config", "--get", "init.defaultBranch")).trim();
    let base = "";
    for (const ref of [remote, "refs/heads/main", "refs/heads/master", configured ? `refs/heads/${configured}` : ""]) {
      if (!ref) continue;
      base = (await read("merge-base", "HEAD", ref)).trim();
      if (base) break;
    }
    const changed = sorted([
      ...names(base ? await read("diff", "--name-only", "-z", "--no-ext-diff", base, "HEAD", "--") : ""),
      ...names(await read("diff", "--name-only", "-z", "--no-ext-diff", "HEAD", "--")),
      ...names(await read("diff", "--cached", "--name-only", "-z", "--no-ext-diff", "HEAD", "--")),
      ...names(await read("ls-files", "--others", "--exclude-standard", "-z")),
    ]);
    return { root, changed, tracked: sorted(names(await read("ls-files", "-z"))) };
  }

  /** Derived world state only: never fabricate a helper or overwrite reported activity. */
  forAgent(agent: WorldAgent, agents: WorldAgent[], work: Work[], teams: Team[], now = Date.now()): ReviewExcerpt | null {
    if (agent.status === "offline") return null;
    const helpers = agent.helpers.filter(isReviewHelper);
    const reported = helpers.filter((h) => h.excerpt).sort((a, b) =>
      (b.excerpt?.viewedAt ?? 0) - (a.excerpt?.viewedAt ?? 0) || a.id.localeCompare(b.id))[0]?.excerpt;
    if (reported) return reported;
    const review = work.filter((w) => w.state === "in_review" &&
      (w.reviewerId ? w.reviewerId === agent.id : w.toTeamId === agent.teamId && agent.role === "lead"))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (review) {
      const cwd = agents.find((a) => a.id === review.fromAgentId)?.cwd
        ?? teams.find((t) => t.id === review.fromTeamId)?.path ?? null;
      return this.excerpt(cwd, review.id, now);
    }
    const helper = helpers.sort((a, b) => a.id.localeCompare(b.id))[0];
    return helper ? this.excerpt(agent.cwd, helper.id, now) : null;
  }

  excerpt(cwd: string | null, reviewId: string, now = Date.now()): ReviewExcerpt | null {
    if (!cwd) return null;
    const seed = `${reviewId}:${Math.floor(now / SLOT_MS)}`;
    void this.refresh(cwd, now);
    const files = this.lists.get(checkoutKey(cwd))?.files;
    if (!files) return null; // Cold cache: do not block the world snapshot on git.
    const tried = new Set<string>();
    // Every changed candidate is tried before any unchanged tracked candidate. Rejected
    // files never contribute a path or bytes to the result. Contents are NOT cached, so a
    // newly credential-bearing file is withheld even inside a cached list's lifetime.
    for (const group of [files.changed, files.tracked]) {
      const start = hash(seed) % Math.max(1, group.length);
      for (let i = 0; i < group.length; i++) {
        const path = group[(start + i) % group.length]!;
        if (tried.has(path)) continue;
        tried.add(path);
        const excerpt = reviewExcerpt(files.root, path, 1, hash(`${seed}:${path}`));
        if (excerpt?.lines.some((line) => line.trim())) { this.nextSlot(now); return excerpt; }
      }
    }
    return null;
  }
}
