// Projector material without asking an agent to do anything. Git supplies names only;
// reviewExcerpt remains the single, fail-closed authority for paths and file contents.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ReviewExcerpt, Team, Work, WorldAgent } from "../shared/types.ts";
import { isReviewHelper } from "../shared/review.ts";
import { reviewExcerpt } from "./review-excerpt.ts";

const SLOT_MS = 20_000;
const LIST_TTL_MS = 10_000;
type FileLists = { root: string | null; changed: string[]; tracked: string[] };
type Git = (cwd: string, args: string[]) => string;
const git: Git = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, maxBuffer: 4 * 1024 * 1024,
});
const hash = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);
const names = (s: string) => s.split("\0").filter(Boolean);
const sorted = (xs: string[]) => [...new Set(xs)].sort();

export class ReviewFallback {
  private lists = new Map<string, { at: number; files: FileLists }>();
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

  private files(cwd: string, now: number): FileLists {
    const cached = this.lists.get(cwd);
    if (cached && now >= cached.at && now - cached.at < LIST_TTL_MS) return cached.files;
    let root: string | null = null;
    try { root = this.run(cwd, ["rev-parse", "--show-toplevel"]).trim() || null; } catch { /* missing checkout */ }
    const read = (...args: string[]) => { try { return root ? this.run(root, args) : ""; } catch { return ""; } };
    // No fetch/network: use the locally known default branch, then conventional local names.
    const remote = read("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").trim();
    const configured = read("config", "--get", "init.defaultBranch").trim();
    let base = "";
    for (const ref of [remote, "refs/heads/main", "refs/heads/master", configured ? `refs/heads/${configured}` : ""]) {
      if (!ref) continue;
      base = read("merge-base", "HEAD", ref).trim();
      if (base) break;
    }
    const changed = sorted([
      ...names(base ? read("diff", "--name-only", "-z", "--no-ext-diff", base, "HEAD", "--") : ""),
      ...names(read("diff", "--name-only", "-z", "--no-ext-diff", "HEAD", "--")),
      ...names(read("diff", "--cached", "--name-only", "-z", "--no-ext-diff", "HEAD", "--")),
      ...names(read("ls-files", "--others", "--exclude-standard", "-z")),
    ]);
    const files = { root, changed, tracked: sorted(names(read("ls-files", "-z"))) };
    // Bounded even when many short-lived review checkouts pass through the office.
    if (this.lists.size >= 64) this.lists.delete(this.lists.keys().next().value!);
    this.lists.set(cwd, { at: now, files });
    return files;
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
    const files = this.files(cwd, now);
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
