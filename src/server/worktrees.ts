// What git says about a checkout: the worktree it is, the repository it belongs to and the
// branch it is on, and whether finishing a project there would lose anything.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { projectSlug } from "../shared/slug.ts";

export interface Checkout {
  /** The top of the worktree. */
  top: string;
  repoName: string;
  /** The main checkout, whose folder the repository's worktrees sit beside. */
  repoRoot: string;
  branch: string | null;
  /** This worktree's own git directory, whose HEAD says the branch without asking git again. */
  gitDir: string;
  /** A worktree made beside the main checkout, which is what a project works in. */
  linked: boolean;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
}

export function checkoutOf(cwd: string): Checkout | null {
  try {
    const [top, common, gitDir, branch] = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir", "--abbrev-ref", "HEAD"]).split("\n");
    if (!top || !common || !gitDir) return null;
    const repoRoot = basename(common) === ".git" ? dirname(common) : common;
    return { top, repoName: basename(repoRoot), repoRoot, branch: branch && branch !== "HEAD" ? branch : null, gitDir, linked: top !== repoRoot };
  } catch {
    return null;
  }
}

/** The branch a checkout is on now, read from its HEAD: a checkout seen earlier may have switched since. */
export function currentBranch(checkout: Checkout): string | null {
  try {
    return readFileSync(join(checkout.gitDir, "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/m)?.[1] ?? null;
  } catch {
    return checkout.branch;
  }
}

/** A repository's linked worktrees (not its main checkout), as git lists them. */
export function linkedWorktrees(repoRoot: string): string[] {
  try {
    const tops = git(repoRoot, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    return tops.filter((top) => top !== repoRoot);
  } catch {
    return [];
  }
}

/** Changed and untracked files, which removing the worktree would throw away. */
export function uncommitted(path: string): number {
  return git(path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
}

/**
 * Processes running inside a worktree (their working directory is in it), such as a dev server
 * an agent left behind: closing its panes does not stop them, and they keep writing into it.
 */
export function processesIn(path: string): Array<{ pid: number; command: string }> {
  let out: string;
  try {
    out = execFileSync("lsof", ["-a", "-d", "cwd", "-F", "pcn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 20_000_000 });
  } catch (err) {
    // lsof exits 1 when some processes could not be read, but still prints the rest.
    out = String((err as { stdout?: string }).stdout ?? "");
  }
  const found: Array<{ pid: number; command: string }> = [];
  let pid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) (pid = Number(line.slice(1))), (command = "");
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n") && pid !== process.pid && (line.slice(1) === path || line.slice(1).startsWith(`${path}/`))) found.push({ pid, command });
  }
  return found;
}

/** Asks the processes to stop, and ends those still running after a few seconds. */
export async function stopProcesses(processes: Array<{ pid: number }>): Promise<void> {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const p of processes) if (alive(p.pid)) process.kill(p.pid, "SIGTERM");
  for (let i = 0; i < 30 && processes.some((p) => alive(p.pid)); i++) await new Promise((r) => setTimeout(r, 100));
  for (const p of processes) if (alive(p.pid)) process.kill(p.pid, "SIGKILL");
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

/** A project's worktree and branch, beside the main checkout: `lantern-search` on `worktree-search`. */
export function placeFor(repoRoot: string, name: string): { slug: string; path: string; branch: string } | null {
  const slug = projectSlug(name);
  if (!slug) return null;
  return { slug, path: join(dirname(repoRoot), `${basename(repoRoot)}-${slug}`), branch: `worktree-${slug}` };
}

/** A project's name from its worktree's folder: `lantern-note-search` → "Note search". */
export function nameFor(checkout: Checkout): string {
  const folder = basename(checkout.top);
  const rest = folder.startsWith(`${checkout.repoName}-`) ? folder.slice(checkout.repoName.length + 1) : folder;
  const words = rest.replace(/[-_]+/g, " ").trim() || folder;
  return words[0]!.toUpperCase() + words.slice(1);
}

/**
 * The main checkouts directly inside a folder: a subfolder whose `.git` is a directory. A linked
 * worktree (its `.git` is a file) is left out, so `lantern-search` is not offered beside
 * `lantern`. One level only, and no git process: a readdir and a stat per folder.
 */
export function checkoutsIn(parent: string): Array<{ name: string; root: string; branch: string | null }> {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const found: Array<{ name: string; root: string; branch: string | null }> = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const root = join(parent, name);
    try {
      if (!statSync(join(root, ".git")).isDirectory()) continue;
      const branch = readFileSync(join(root, ".git", "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/m)?.[1] ?? null;
      found.push({ name, root, branch });
    } catch {
      continue;
    }
  }
  return found;
}

/** Whether a folder's repositories are worth listing: not the home folder or the root, which hold everything and are noise. */
export function isProjectsFolder(parent: string): boolean {
  return parent !== "/" && parent !== homedir();
}
