import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PipelineCandidate } from "../../shared/pipeline.ts";
import { InboxError } from "../inbox.ts";
import { within } from "./discovery.ts";

export function git(cwd: string, args: string[]): string {
  try { return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trimEnd(); }
  catch { throw new InboxError(409, "pipeline checkout or Git reference is unavailable", "pipeline_candidate_unavailable"); }
}
export function repository(checkout: string): { root: string; common: string; top: string } {
  const top = realpathSync(git(checkout, ["rev-parse", "--show-toplevel"]));
  const common = realpathSync(git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const trees = git(top, ["worktree", "list", "--porcelain"]);
  const main = /^worktree (.+)$/m.exec(trees)?.[1];
  return { top, common, root: main ? realpathSync(main) : dirname(common) };
}
function ref(value: string): string {
  if (!value || value.startsWith("-") || !/^[\w/.-]+$/.test(value)) throw new InboxError(400, "pipeline references must be commit ids or simple Git refs");
  return value;
}
export function capture(checkout: string, base = "HEAD", candidate = "HEAD", fingerprintVersion: 1 | 2 = 2): PipelineCandidate {
  const repo = repository(checkout);
  const head = git(repo.top, ["rev-parse", "--verify", `${ref(candidate)}^{commit}`]);
  if (head !== git(repo.top, ["rev-parse", "HEAD"])) throw new InboxError(409, "candidate must be checked out; use an owned checkout at the pinned candidate", "pipeline_stale_candidate");
  const baseSha = git(repo.top, ["rev-parse", "--verify", `${ref(base)}^{commit}`]);
  const paths = git(repo.top, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseSha, "--"]).split("\0").filter(Boolean);
  const untracked = git(repo.top, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const changedPaths = [...new Set([...paths, ...untracked])].sort();
  const tree = new Map<string, [string, string]>();
  for (const entry of git(repo.top, ["ls-tree", "-r", "-z", baseSha]).split("\0").filter(Boolean)) {
    const m = /^(\d+) (\w+) (\w+)\t([\s\S]*)$/.exec(entry);
    if (!m) throw new InboxError(409, "candidate tree could not be read");
    tree.set(m[4]!, [m[1]!, m[3]!]);
  }
  const format = git(repo.top, ["rev-parse", "--show-object-format"]);
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
  const intended = fingerprintVersion === 1 ? [...tree].sort(([a], [b]) => a.localeCompare(b)) : changedPaths.map(path => [path, tree.get(path) ?? null]);
  const fingerprint = createHash("sha256").update(JSON.stringify(intended)).digest("hex");
  return { checkout: repo.top, repoRoot: repo.root, base: baseSha, head, tree: git(repo.top, ["rev-parse", `${head}^{tree}`]), fingerprint, changedPaths,
    ...(fingerprintVersion === 2 ? { fingerprintVersion: 2 as const } : {}) };
}
/** No fetch or local-branch shortcut: publication is witnessed by remote-tracking refs. */
export function requirePublishedBase(candidate: PipelineCandidate, integrationBranch: string): void {
  const refs = git(candidate.checkout, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]).split("\n")
    .filter(name => name.replace(/^refs\/remotes\/[^/]+\//, "") === integrationBranch);
  const ancestor = (base: string, tip: string): boolean => {
    try { git(candidate.checkout, ["merge-base", "--is-ancestor", base, tip]); return true; } catch { return false; }
  };
  if (!refs.some(ref => ancestor(candidate.base, ref))) throw new InboxError(409, `new base is not published on a remote-tracking ${integrationBranch} branch; fetch the integration branch first`, "pipeline_base_unpublished");
  if (!ancestor(candidate.base, candidate.head)) throw new InboxError(409, "new base must be an ancestor of the candidate", "pipeline_base_not_ancestor");
}
export function sameCandidate(saved: PipelineCandidate): boolean {
  try { const current = capture(saved.checkout, saved.base, "HEAD", saved.fingerprintVersion ?? 1); return current.head === saved.head && current.fingerprint === saved.fingerprint; }
  catch { return false; }
}
