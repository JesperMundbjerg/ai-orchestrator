import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PipelineCandidate } from "../../shared/pipeline.ts";
import type { DatabaseSync } from "node:sqlite";
import { InboxError } from "../inbox.ts";
import { gitPending, isGitPending, gitNonblocking, gitOutput, inPass, outsidePass, punch, refused, rethrowPending, runPass, settle, stalled, ticket } from "../gitcache.ts";
import { within } from "./discovery.ts";

/** Inside an office pass git is read from gitcache.ts (never a process on the event loop); outside one, synchronously. */
export function git(cwd: string, args: string[]): string {
  const full = ["-c", "core.fsmonitor=false", ...args];
  try { return gitOutput({ cwd, args: full, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, () => execFileSync("git", full, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })).trimEnd(); }
  catch (err) { if (isGitPending(err)) throw err; throw new InboxError(409, "pipeline checkout or Git reference is unavailable", "pipeline_candidate_unavailable"); }
}
type Repo = { root: string; common: string; top: string };
type Memo<T> = { value: T } | { error: unknown };
/** One request's reads of the repository. Every office request is answered synchronously, so a scope never spans an
 * await or a second request: the next request reads the repository as it is then. The read and decision paths open one. */
let scope: { repositories: Map<string, Memo<Repo>>; captures: Map<string, Memo<PipelineCandidate>>; values: Map<string, Memo<unknown>> } | null = null;
function scoped<T>(read: () => T): T {
  scope = { repositories: new Map(), captures: new Map(), values: new Map() };
  try {
    const result = read();
    if (result instanceof Promise) throw new Error("a request scope is synchronous: it cannot span an await");
    return result;
  } finally { scope = null; }
}
/**
 * How a request reads Git when the office runs non-blocking (gitcache.ts); without it, as before, synchronously.
 * - `decide`: the request decides (the gate, an edit, a delivery). It uses only Git facts read since it was first
 *   asked; a fact being read is never taken for "no" (rethrowPending), and a miss refuses with GitPending, which is
 *   retryable. Meanwhile the decision is re-run in the background, inside a savepoint that is always rolled back and
 *   with nothing noted, until it misses nothing, so the retry is answered.
 * - `view`: the request only shows. It uses the last facts read; one never read yet counts as unavailable, the answer
 *   says so (`note`), and once the facts are read the office redraws (`done`). With `wait`, a request that misses
 *   facts waits briefly for them and only then answers its noted fallback.
 */
export interface RequestGit<T> {
  decide?: string;
  view?: { key: string; note?: (value: T) => T; wait?: boolean; done?: () => void };
  db?: DatabaseSync;
  /** Whether the request remembers its reads (a scope); false keeps a decision reading afresh after its own writes. */
  memo?: boolean;
}
export function inRequest<T>(read: () => T, git: RequestGit<T> = {}): T {
  const body = () => scope || git.memo === false ? read() : scoped(read);
  if (!gitNonblocking() || inPass() || (!git.decide && !git.view)) return body();
  // Answered only git_pending for too long: read git synchronously this once rather than refuse forever (gitcache.ts).
  // The office's dispatcher runs a refused request again within its wait, so the request past the bound is answered.
  if (git.decide && stalled(git.decide)) { try { return outsidePass(body); } finally { punch(git.decide); } }
  const horizon = git.decide ? ticket(git.decide) : null;
  const decide = Boolean(git.decide);
  const pass = runPass(body, { horizon, decide });
  if (!pass.waits.length) {
    if (git.decide) punch(git.decide);
    if ("error" in pass) throw pass.error;
    return pass.value as T;
  }
  const again = () => speculatively(git.db, () => runPass(body, { horizon, decide, speculative: true }).waits);
  const settled = settle(git.decide ?? git.view!.key, pass.waits, again, git.view?.done);
  if (git.decide) refused(git.decide);
  if (git.decide || "error" in pass) throw gitPending(settled);
  const shown = git.view?.note ? git.view.note(pass.value as T) : pass.value as T;
  if (git.view?.wait) throw gitPending(settled, shown);
  return shown;
}
/** Runs a background rerun so that nothing it writes is kept. */
function speculatively<T>(db: DatabaseSync | undefined, fn: () => T): T {
  if (!db) return fn();
  db.exec("SAVEPOINT git_speculation");
  try { return fn(); } finally { db.exec("ROLLBACK TO git_speculation"); db.exec("RELEASE git_speculation"); }
}
function remembered<T>(memo: Map<string, Memo<T>> | undefined, key: string, read: () => T): T {
  const seen = memo?.get(key);
  if (seen) { if ("error" in seen) throw seen.error; return seen.value; }
  let entry: Memo<T>;
  try { entry = { value: read() }; } catch (error) { entry = { error }; }
  memo?.set(key, entry);
  if ("error" in entry) throw entry.error;
  return entry.value;
}
/** Reads `read` once for the whole request when one is open, and every time otherwise. For what is costly to compute
 * and cannot change while a synchronous request runs, such as the office's world. */
export function inScope<T>(key: string, read: () => T): T {
  return remembered(scope?.values as Map<string, Memo<T>> | undefined, key, read);
}
export function repository(checkout: string): Repo {
  return remembered(scope?.repositories, checkout, () => readRepository(checkout));
}
function readRepository(checkout: string): Repo {
  const [toplevel, commonDir] = git(checkout, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"]).split("\n");
  if (!toplevel || !commonDir) throw new InboxError(409, "pipeline checkout or Git reference is unavailable", "pipeline_candidate_unavailable");
  const top = realpathSync(toplevel);
  const common = realpathSync(commonDir);
  const trees = git(top, ["worktree", "list", "--porcelain"]);
  const main = /^worktree (.+)$/m.exec(trees)?.[1];
  return { top, common, root: main ? realpathSync(main) : dirname(common) };
}
function ref(value: string): string {
  if (!value || value.startsWith("-") || !/^[\w/.-]+$/.test(value)) throw new InboxError(400, "pipeline references must be commit ids or simple Git refs");
  return value;
}
export function capture(checkout: string, base = "HEAD", candidate = "HEAD", fingerprintVersion: 1 | 2 = 2, priorPaths?: string[]): PipelineCandidate {
  const key = JSON.stringify([checkout, base, candidate, fingerprintVersion, priorPaths ?? null]);
  return structuredClone(remembered(scope?.captures, key, () => readCapture(checkout, base, candidate, fingerprintVersion, priorPaths)));
}
function readCapture(checkout: string, base: string, candidate: string, fingerprintVersion: 1 | 2, priorPaths?: string[]): PipelineCandidate {
  const repo = repository(checkout);
  const [head, current, baseSha, format, treeId] = git(repo.top, ["rev-parse", `${ref(candidate)}^{commit}`, "HEAD", `${ref(base)}^{commit}`, "--show-object-format", `${ref(candidate)}^{tree}`]).split("\n");
  if (!head || !current || !baseSha || !format || !treeId) throw new InboxError(409, "pipeline checkout or Git reference is unavailable", "pipeline_candidate_unavailable");
  if (head !== current) throw new InboxError(409, "candidate must be checked out; use an owned checkout at the pinned candidate", "pipeline_stale_candidate");
  const paths = git(repo.top, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseSha, "--"]).split("\0").filter(Boolean);
  const untracked = git(repo.top, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const changedPaths = [...new Set([...paths, ...untracked])].sort();
  const tree = treeEntries(repo.top, baseSha);
  let bytes = 0;
  for (const path of changedPaths) {
    const file = resolve(repo.top, path);
    if (!within(repo.top, file)) throw new InboxError(409, "candidate path escapes checkout");
    let s;
    try { s = lstatSync(file); } catch { tree.delete(path); continue; }
    if (!s.isFile() && !s.isSymbolicLink()) throw new InboxError(409, "changed submodules/special files need a separately scoped candidate");
    if (s.isFile() && !within(repo.top, realpathSync(file))) throw new InboxError(409, "candidate file escapes checkout");
    bytes += s.size;
    if (bytes > 64 * 1024 * 1024) throw new InboxError(409, "changed candidate bytes exceed the 64 MB safe snapshot limit");
    const body = s.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    const blob = createHash(format).update(`blob ${body.length}\0`).update(body).digest("hex");
    tree.set(path, [s.isSymbolicLink() ? "120000" : s.mode & 0o111 ? "100755" : "100644", blob]);
  }
  // Git blob ids, modes and paths are identical before/after staging or a metadata-only
  // commit. No temporary Git index, object write, textconv, hooks or project code execution.
  // Hash only this wave's scope. Unchanged upstream paths must not invalidate its
  // receipts after a protected re-base; additions, deletions and modes still count.
  const fingerprintPaths = [...new Set([...changedPaths, ...(fingerprintVersion === 2 ? priorPaths ?? [] : [])])].sort();
  const fingerprint = intendedBytes(tree, fingerprintPaths, fingerprintVersion);
  return { checkout: repo.top, repoRoot: repo.root, base: baseSha, head, tree: treeId, fingerprint, changedPaths,
    ...(fingerprintVersion === 2 ? { fingerprintVersion: 2 as const } : {}),
    ...(fingerprintPaths.length > changedPaths.length ? { fingerprintPaths } : {}) };
}
function intendedBytes(tree: Map<string, [string, string]>, changedPaths: string[], fingerprintVersion: 1 | 2): string {
  const intended = fingerprintVersion === 1 ? [...tree].sort(([a], [b]) => a.localeCompare(b)) : changedPaths.map(path => [path, tree.get(path) ?? null]);
  return createHash("sha256").update(JSON.stringify(intended)).digest("hex");
}
function treeEntries(cwd: string, commit: string): Map<string, [string, string]> {
  const tree = new Map<string, [string, string]>();
  for (const entry of git(cwd, ["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean)) {
    const m = /^(\d+) (\w+) (\w+)\t([\s\S]*)$/.exec(entry);
    if (!m) throw new InboxError(409, "candidate tree could not be read");
    tree.set(m[4]!, [m[1]!, m[3]!]);
  }
  return tree;
}
/**
 * The candidate's intended bytes as its commit holds them, read from Git objects alone: what capture()
 * gives on a clean checkout at that commit. A delivered candidate is recognised after its checkout moved on,
 * and a pin that included bytes the commit lacks never matches.
 */
export function committedFingerprint(cwd: string, candidate: PipelineCandidate): string {
  const changedPaths = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", candidate.base, candidate.head, "--"]).split("\0").filter(Boolean).sort();
  const tree = treeEntries(cwd, candidate.base); const committed = treeEntries(cwd, candidate.head);
  for (const path of changedPaths) { const entry = committed.get(path); if (entry) tree.set(path, entry); else tree.delete(path); }
  return intendedBytes(tree, [...new Set([...changedPaths, ...(candidate.fingerprintPaths ?? [])])].sort(), candidate.fingerprintVersion ?? 1);
}
/**
 * What a candidate changes, independent of where it sits: the `git patch-id` of the whole `base..head` diff
 * (one diff, so a multi-commit candidate is judged as the change it makes, however its commits are split),
 * plus each changed path's status and modes, which a patch id does not hash. `--verbatim` is `--stable` that
 * keeps whitespace, so an indentation-only edit while resolving a conflict is a different change. Line numbers
 * and blob ids are not part of it, so the same change re-based onto a moved base keeps its identity. The diff is
 * read with every user setting that could reshape it pinned. Null when there is nothing to compare or Git cannot
 * say: never "the same".
 */
export function patchIdentity(cwd: string, base: string, head: string): string | null {
  const run = (args: string[], input?: string) => { const full = ["-c", "core.fsmonitor=false", ...args]; return gitOutput({ cwd, args: full, ...(input === undefined ? {} : { input }), timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
    () => execFileSync("git", full, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input, stdio: ["pipe", "pipe", "pipe"] }) })); };
  try {
    const shape = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--no-color", "--diff-algorithm=myers", "-O/dev/null"];
    const diff = run(["diff", ...shape, "--full-index", "--binary", "--src-prefix=a/", "--dst-prefix=b/", ref(base), ref(head), "--"]);
    if (!diff) return null;
    const id = run(["patch-id", "--verbatim"], diff).split(/\s+/)[0];
    if (!id || !/^[0-9a-f]+$/.test(id)) return null;
    // ":<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0" per path: keep all but the blob ids.
    const raw = run(["diff", ...shape, "--raw", "-z", ref(base), ref(head), "--"]).split("\0");
    const modes: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) { const [oldMode, newMode, , , status] = raw[i]!.replace(/^:/, "").split(" "); modes.push(`${oldMode} ${newMode} ${status} ${raw[i + 1]}`); }
    return `${id}:${createHash("sha256").update(modes.join("\n")).digest("hex").slice(0, 16)}`;
  } catch (err) { rethrowPending(err); return null; }
}
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try { git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch (err) { rethrowPending(err); return false; }
}
/**
 * Where a protected branch is published: `origin/<branch>` in a repository with remotes (a push updates
 * it only on success; a local branch there may be unpushed), the local branch only when there are none,
 * and not while `checkout` has it checked out: commits there are that checkout's work, not a delivery.
 */
export function publishedBranch(cwd: string, branch: string, checkout: string): { ref: string; tip: string } | null {
  let ref = `refs/remotes/origin/${branch}`;
  if (!git(cwd, ["remote"])) {
    ref = `refs/heads/${branch}`;
    try { if (git(checkout, ["symbolic-ref", "-q", "HEAD"]) === ref) return null; } catch (err) { rethrowPending(err); /* detached, or the checkout is gone */ }
  }
  try { return { ref, tip: git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) }; } catch (err) { rethrowPending(err); return null; }
}
/** No fetch or local-branch shortcut: publication is witnessed by remote-tracking refs. */
export function requirePublishedBase(candidate: PipelineCandidate, integrationBranch: string): void {
  const refs = git(candidate.checkout, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]).split("\n")
    .filter(name => name.replace(/^refs\/remotes\/[^/]+\//, "") === integrationBranch);
  const ancestor = (base: string, tip: string): boolean => isAncestor(candidate.checkout, base, tip);
  if (!refs.some(ref => ancestor(candidate.base, ref))) throw new InboxError(409, `new base is not published on a remote-tracking ${integrationBranch} branch; fetch the integration branch first`, "pipeline_base_unpublished");
  if (!ancestor(candidate.base, candidate.head)) throw new InboxError(409, "new base must be an ancestor of the candidate", "pipeline_base_not_ancestor");
}
export function sameCandidate(saved: PipelineCandidate): boolean {
  try { const current = capture(saved.checkout, saved.base, "HEAD", saved.fingerprintVersion ?? 1, saved.fingerprintPaths); return current.head === saved.head && current.fingerprint === saved.fingerprint; }
  catch (err) { rethrowPending(err); return false; }
}
/** The lane whose worktree this checkout is, when `pipelineHooks.laneDelivery` lets that lane deliver outside
 * office runs. Such a checkout never holds a run: the hooks would treat its delivery as the lane's own. */
export function laneCheckout(repoRoot: string, checkout: string): string | null {
  let adapter: { lanes?: { name?: unknown; worktree?: unknown }[]; pipelineHooks?: { laneDelivery?: { lanes?: unknown[] } } };
  try { adapter = JSON.parse(readFileSync(resolve(repoRoot, "orchestrator.json"), "utf8")); } catch { return null; }
  const names = adapter?.pipelineHooks?.laneDelivery?.lanes;
  if (!Array.isArray(names)) return null;
  for (const lane of Array.isArray(adapter.lanes) ? adapter.lanes : []) {
    if (!lane || typeof lane.name !== "string" || typeof lane.worktree !== "string" || !names.includes(lane.name)) continue;
    try { if (realpathSync(resolve(repoRoot, lane.worktree)) === realpathSync(checkout)) return lane.name; } catch { /* absent here */ }
  }
  return null;
}
