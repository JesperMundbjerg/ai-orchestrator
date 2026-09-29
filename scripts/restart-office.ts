// Restarts the office from this checkout in one command: `npm run restart-office [-- --build]`.
// Stops whatever office listens on INBOX_PORT (only if it is `node src/server/main.ts`), starts a
// new one detached with its output appended to office.log in the data directory, and waits until
// it answers. herdr's settings come from the environment, else office.env in the data directory,
// else the running office's own environment. It never stops herdr itself.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERDR_KEYS = ["HERDR_BIN_PATH", "HERDR_SOCKET_PATH"] as const;
type HerdrKey = (typeof HERDR_KEYS)[number];
export type Settings = Record<HerdrKey, string>;

/** KEY=VALUE lines; blank lines, `# comments` and a leading `export` are allowed, and quotes around a value are dropped. */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    vars[key] = value;
  }
  return vars;
}

/** The variables `ps eww` shows after a process's command, for the keys asked for. */
export function envFromPs(line: string, keys: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of keys) {
    const match = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
    if (match) vars[key] = match[1]!;
  }
  return vars;
}

/**
 * Each herdr setting from the first place that has it: this environment, office.env, then the
 * running office. What none of them has is named in `missing`.
 */
export function chooseSettings(sources: { env: Record<string, string | undefined>; file: Record<string, string>; running: Record<string, string> }): { settings: Partial<Settings>; missing: HerdrKey[] } {
  const settings: Partial<Settings> = {};
  const missing: HerdrKey[] = [];
  for (const key of HERDR_KEYS) {
    const value = sources.env[key] || sources.file[key] || sources.running[key];
    if (value) settings[key] = value;
    else missing.push(key);
  }
  return { settings, missing };
}

/** Whether a process's command line is the office: node running src/server/main.ts (relative or absolute). */
export function isOffice(command: string): boolean {
  const [program, ...args] = command.trim().split(/\s+/);
  if (!program || !/^node(\d+)?$/.test(basename(program))) return false;
  const script = args.find((a) => !a.startsWith("-"));
  return script === "src/server/main.ts" || !!script?.endsWith("/src/server/main.ts");
}

const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const listener = (port: number) => Number(run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).split("\n")[0]) || null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(ok: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await ok()) return true;
  return false;
}

async function main(): Promise<string> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const port = Number(process.env.INBOX_PORT ?? 4870);
  const dir = process.env.INBOX_DATA_DIR ?? join(homedir(), ".review-inbox");
  const envFile = join(dir, "office.env");
  const logFile = join(dir, "office.log");
  const file = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};

  const pid = listener(port);
  if (pid) {
    const command = run("ps", ["-o", "command=", "-p", String(pid)]);
    if (!isOffice(command)) throw new Error(`Port ${port} is held by something else (pid ${pid}: ${command || "unknown"}); not stopping it.`);
  }
  const running = pid ? envFromPs(run("ps", ["eww", "-o", "command=", "-p", String(pid)]), HERDR_KEYS) : {};
  const { settings, missing } = chooseSettings({ env: process.env, file, running });
  if (missing.length) throw new Error(`Not restarting: ${missing.join(" and ")} not set. Put ${missing.map((k) => `${k}=…`).join(" and ")} in ${envFile}.`);

  mkdirSync(dir, { recursive: true });
  const log = openSync(logFile, "a");
  if (process.argv.includes("--build")) {
    const built = spawnSync(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build"], { cwd: root, stdio: ["ignore", log, log] });
    if (built.status !== 0) throw new Error(`The build failed; the office was left running. See ${logFile}.`);
  }

  if (pid) {
    process.kill(pid, "SIGTERM");
    if (!(await until(() => listener(port) === null, 5000))) {
      process.kill(pid, "SIGKILL");
      if (!(await until(() => listener(port) === null, 3000))) throw new Error(`The office on ${port} (pid ${pid}) would not stop.`);
    }
  }

  const child = spawn(process.execPath, ["src/server/main.ts"], { cwd: root, env: { ...file, ...process.env, ...settings }, detached: true, stdio: ["ignore", log, log] });
  let exited: number | null | undefined;
  child.on("exit", (code) => (exited = code));
  const up = await until(async () => {
    if (exited !== undefined) return true;
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/world`)).status === 200;
    } catch {
      return false;
    }
  }, 15_000);
  child.unref();
  if (exited !== undefined) throw new Error(`The office stopped straight away (exit ${exited}). See ${logFile}.`);
  if (!up) throw new Error(`The office (pid ${child.pid}) did not answer on ${port} within 15 s. See ${logFile}.`);
  return `Office ${pid ? "restarted" : "started"} on ${port} (pid ${child.pid})`;
}

if (import.meta.main) {
  main().then(
    (line) => (console.log(line), process.exit(0)),
    (e: Error) => (console.error(e.message), process.exit(1)),
  );
}
