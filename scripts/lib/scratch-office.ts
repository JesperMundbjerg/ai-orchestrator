// Scratch verification children only; never discover a cleanup target by name or port.
import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ScratchIdentity = { pid: number; pgid: number; start: string; command: string; token: string };
export type ScratchRecord = ScratchIdentity & { executable: string; args: string[]; port: number };
const TOKEN = "INBOX_SCRATCH_PROCESS_TOKEN";
function ps(pid: number, field: string, environment = false): string {
  return execFileSync("ps", [...(environment ? ["eww"] : ["-ww"]), "-p", String(pid), "-o", `${field}=`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();
}

/** Fail closed on inspection failure. The launch token also disambiguates same-second PID reuse on macOS. */
export function inspectScratchProcess(pid: number): ScratchIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const command = ps(pid, "command");
    const pgid = Number(ps(pid, "pgid"));
    let start: string;
    let environment: string;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return null;
      start = fields[19]!; // /proc field 22: monotonic start ticks, not elapsed time.
      environment = readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", " ");
    } else if (process.platform === "darwin") {
      if (ps(pid, "stat").startsWith("Z")) return null;
      start = ps(pid, "lstart");
      environment = ps(pid, "command", true);
    } else return null;
    const token = environment.match(new RegExp(`(?:^|\\s)${TOKEN}=([^\\s]+)(?:\\s|$)`))?.[1];
    if (!command || !start || !token || !pgid) return null;
    return { pid, pgid, start, command, token };
  } catch { return null; }
}
function sameProcess(expected: ScratchIdentity, current: ScratchIdentity | null): boolean {
  return !!current && expected.pid === current.pid && expected.pgid === current.pgid && expected.start === current.start && expected.command === current.command && expected.token === current.token;
}

// Resolve symlinks even when the final directory does not exist yet.
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), absolute.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
}
export function assertScratchEnvironment(env: NodeJS.ProcessEnv): number {
  const port = Number(env.INBOX_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 4870) throw new Error("Scratch office requires an explicit safe port (never 4870)");
  const homes = [userInfo().homedir, homedir()].map(canonical);
  if (!env.HOME || homes.includes(canonical(env.HOME))) throw new Error("Scratch office requires an isolated HOME");
  if (!env.INBOX_DATA_DIR || homes.map(h => canonical(join(h, ".review-inbox"))).includes(canonical(env.INBOX_DATA_DIR))) throw new Error("Scratch office must never use the real ~/.review-inbox data directory");
  for (const key of ["INBOX_CODEX_ACCOUNT_POLLING", "INBOX_PRESENCE_DISCOVERY", "INBOX_BROWSER_CLEANUP"]) {
    if (env[key] !== "0") throw new Error(`Scratch office requires ${key}=0`);
  }
  if (env.HERDR_SOCKET_PATH !== "/nonexistent" || env.HERDR_BIN_PATH !== "/usr/bin/false") throw new Error("Scratch office requires disabled herdr paths");
  return port;
}

type StopOptions = { termTimeoutMs?: number; killTimeoutMs?: number; inspect?: typeof inspectScratchProcess; signal?: (pid: number, signal: NodeJS.Signals) => void };
/** Recheck before EACH group signal. Gone/reused/uninspectable means no signal, including escalation. */
export async function stopScratchRecord(record: ScratchRecord, options: StopOptions = {}): Promise<"stopped" | "gone-or-changed"> {
  const inspect = options.inspect ?? inspectScratchProcess;
  const signal = options.signal ?? ((pid, sig) => process.kill(pid, sig));
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || record.pgid !== record.pid || record.port === 4870) throw new Error("Refusing an unowned scratch process group");
  const send = (sig: NodeJS.Signals) => {
    if (!sameProcess(record, inspect(record.pid))) return false;
    try { signal(-record.pgid, sig); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
  };
  const wait = async (ms: number) => {
    const end = Date.now() + ms;
    while (sameProcess(record, inspect(record.pid))) {
      if (Date.now() >= end) return false;
      await delay(50);
    }
    return true;
  };
  if (!send("SIGTERM")) return "gone-or-changed";
  if (await wait(options.termTimeoutMs ?? 3000)) return "stopped";
  if (!send("SIGKILL")) return "gone-or-changed";
  if (!await wait(options.killTimeoutMs ?? 3000)) throw new Error(`Scratch child ${record.pid} did not stop`);
  return "stopped";
}

export async function spawnScratchOffice(executable: string, args: string[], options: SpawnOptions): Promise<{ child: ChildProcess; record: ScratchRecord; stop: () => Promise<void> }> {
  const port = assertScratchEnvironment(options.env ?? process.env);
  if (!["darwin", "linux"].includes(process.platform) || options.shell) throw new Error("Scratch children require macOS/Linux and no shell");
  const token = randomUUID();
  const child = spawn(executable, args, { ...options, detached: true, env: { ...(options.env ?? process.env), [TOKEN]: token } });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const identity = inspectScratchProcess(child.pid!);
  if (!identity || identity.token !== token || identity.pgid !== child.pid) throw new Error(`Could not verify scratch child ${child.pid}; no cleanup signal sent`);
  const record = Object.freeze({ ...identity, executable, args: [...args], port });
  let stopping: Promise<void> | undefined;
  return { child, record, stop: () => stopping ??= stopScratchRecord(record).then(() => {}) };
}

// The documented custom verification launcher: Ctrl-C/TERM cleans up this launch only.
if (import.meta.main) {
  const office = await spawnScratchOffice(process.execPath, [resolve(import.meta.dirname, "../../src/server/main.ts")], { env: process.env, stdio: "inherit" });
  const stop = () => { void office.stop().catch(e => { console.error(e.message); process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  office.child.once("exit", code => { process.exitCode = code ?? 0; });
}
