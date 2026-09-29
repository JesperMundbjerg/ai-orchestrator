// What git says about a checkout: the worktree it is, the repository it belongs to and the
// branch it is on, and whether finishing a project there would lose anything.

import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { projectSlug } from "../shared/slug.ts";

export interface Checkout {
  /** The top of the worktree. */
  top: string;
  repoName: string;
  /** The main checkout, whose folder the repository's worktrees sit beside. */
  repoRoot: string;
  branch: string | null;
  /** A worktree made beside the main checkout, which is what a project works in. */
  linked: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
}

export function checkoutOf(cwd: string): Checkout | null {
  try {
    const [top, common, branch] = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"]).split("\n");
    if (!top || !common) return null;
    const repoRoot = basename(common) === ".git" ? dirname(common) : common;
    return { top, repoName: basename(repoRoot), repoRoot, branch: branch && branch !== "HEAD" ? branch : null, linked: top !== repoRoot };
  } catch {
    return null;
  }
}

/** Changed and untracked files, which removing the worktree would throw away. */
export function uncommitted(path: string): number {
  return git(path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
}

/** Commits on the branch that its repository's main checkout does not have. */
export function unmerged(repoRoot: string, branch: string): number {
  try {
    return Number(git(repoRoot, ["rev-list", "--count", `HEAD..${branch}`]));
  } catch {
    return 0;
  }
}

/** Deletes the branch only when it is merged into the main checkout's branch; true when it did. */
export function deleteMergedBranch(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ["branch", "-d", branch]);
    return true;
  } catch {
    return false;
  }
}

/** A project's worktree and branch, beside the main checkout: `space-shuttle-atoms-light` on `worktree-atoms-light`. */
export function placeFor(repoRoot: string, name: string): { slug: string; path: string; branch: string } | null {
  const slug = projectSlug(name);
  if (!slug) return null;
  return { slug, path: join(dirname(repoRoot), `${basename(repoRoot)}-${slug}`), branch: `worktree-${slug}` };
}

/** A project's name from its worktree's folder: `space-shuttle-atoms-light` → "Atoms light". */
export function nameFor(checkout: Checkout): string {
  const folder = basename(checkout.top);
  const rest = folder.startsWith(`${checkout.repoName}-`) ? folder.slice(checkout.repoName.length + 1) : folder;
  const words = rest.replace(/[-_]+/g, " ").trim() || folder;
  return words[0]!.toUpperCase() + words.slice(1);
}
