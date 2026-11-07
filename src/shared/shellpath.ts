// The PATH a pane the office or `inbox pane` opens is given, so `claude` and `pi` are found in it
// whatever environment herdr's server was started from: the opener's own PATH, then whatever the
// user's login shell adds. herdr passes it with `--env` (pane split, workspace create); the pane's
// own login shell may still add to it.

import { execFileSync } from "node:child_process";

/** Every folder of the given PATHs once, in the order first seen. */
export function mergePaths(...paths: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  for (const path of paths) for (const dir of (path ?? "").split(":")) if (dir) seen.add(dir);
  return [...seen].join(":");
}

let login: string | null | undefined;

/** The PATH the user's login shell sets up, read once per process; null when it cannot be read in time. */
export function loginShellPath(): string | null {
  if (login !== undefined) return login;
  try {
    login = execFileSync(process.env.SHELL || "/bin/zsh", ["-l", "-c", 'printf "%s" "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    login = null;
  }
  return login;
}

/** herdr's arguments that give a new pane a working PATH. */
export function paneEnvArgs(path = mergePaths(process.env.PATH, loginShellPath())): string[] {
  return path ? ["--env", `PATH=${path}`] : [];
}
