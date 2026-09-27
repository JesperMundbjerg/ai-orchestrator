import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** The repository a checkout belongs to, so every worktree of one repository is one project. */
export function projectRoot(cwd: string): { name: string; root: string } | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const root = basename(common) === ".git" ? dirname(common) : common;
    return { name: basename(root), root };
  } catch {
    return undefined;
  }
}
