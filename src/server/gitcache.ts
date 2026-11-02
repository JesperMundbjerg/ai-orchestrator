// Git off the event loop. The office's read and decision code is synchronous by design (a request scope never
// spans an await), but a git process that takes milliseconds on an idle machine takes seconds on a loaded one,
// and every office request and timer would wait behind it. So inside a pass (an office request or a watch
// sample the caller opened with runPass) a git read never runs a process: it answers from what was read before,
// and a miss starts the read asynchronously (execFile, a few at a time) and throws GitPending.
//
// What a pass may take from what was read before depends on who asks:
//   - a view (horizon null) takes the last value read, whatever its age, and re-reads it in the background
//     when it is older than REFRESH_MS; a fact never read yet is a miss, which the view treats as unavailable;
//   - a decision (horizon: when it was first asked) takes only reads that started at or after its horizon, so
//     it never decides on a fact older than the question. A read whose answer depends on commit ids alone
//     (ls-tree, a diff or merge-base of two commits, a patch id) is the same at any time and is reused.
// Outside a pass, git runs synchronously exactly as before: tests, the CLI and callers not yet moved off it.
// The office opts in with configureGit({ nonblocking: true }) (main.ts); until then no pass is ever opened.

import { execFile } from "node:child_process";
import { InboxError } from "./inbox.ts";

export interface GitCall { cwd: string; args: string[]; input?: string; maxBuffer?: number; timeout?: number }
/** Runs git and resolves with its stdout; rejects when it fails. Injectable so tests can make git slow. */
export type GitRunner = (call: GitCall) => Promise<string>;

/** A git fact this pass may not use yet: being read. Retryable; `settled` resolves when a retry can be answered. */
export type GitPending = InboxError & {
  settled: Promise<void>;
  /** For a read that can answer without the facts it misses (marked as incomplete), what it would answer. */
  fallback?: unknown;
};
const PENDING = Symbol("git pending");
/** An InboxError (503, git_pending), made when thrown: inbox.ts is still loading when this module is (an import cycle). */
export function gitPending(settled: Promise<void> = Promise.resolve(), fallback?: unknown): GitPending {
  const err = Object.assign(new InboxError(503, "the office is reading the checkout from Git (the machine is busy); retry in a few seconds", "git_pending"), { settled, [PENDING]: true });
  return fallback === undefined ? err : Object.assign(err, { fallback });
}
export function isGitPending(err: unknown): err is GitPending {
  return typeof err === "object" && err !== null && PENDING in err;
}

/** A git read that failed, as an asynchronous read reports it inside a pass (the synchronous path throws execFileSync's error). */
export class GitFailed extends Error {
  stdout: string;
  constructor(message: string, stdout = "") { super(message); this.stdout = stdout; }
}

/** A view re-reads a fact in the background when what it was answered from is older than this. */
export const REFRESH_MS = 5_000;
/** A decision first asked this long ago asks again: a retry within it may use what was read since the first ask. */
export const TICKET_MS = 120_000;
/** How long an office request waits for missing facts before answering "retry" (or its fallback). */
let waitMs = 150;
/** How long a decision may keep answering git_pending for the same question before it reads git synchronously. */
let pendingLimitMs = 60_000;
let concurrency = 4;
let nonblocking = false;
let changed: (() => void) | null = null;
export const defaultRunner: GitRunner = (call) => new Promise((resolve, reject) => {
  const child = execFile("git", call.args, { cwd: call.cwd, encoding: "utf8", timeout: Math.max(call.timeout ?? 0, 30_000), maxBuffer: call.maxBuffer ?? 16 * 1024 * 1024 }, (err, stdout) => {
    if (err) reject(Object.assign(new GitFailed(err.message, String(stdout ?? "")), { code: (err as { code?: unknown }).code }));
    else resolve(String(stdout));
  });
  // A git that exits without reading its input (most reads take none) closes the pipe: the write then fails
  // with EPIPE as an unhandled 'error' event. How git ended is the callback's to say, so the pipe error is not.
  child.stdin?.on("error", () => {});
  if (call.input !== undefined) child.stdin?.end(call.input);
  else child.stdin?.end();
});
let runner: GitRunner = defaultRunner;

/** Opts the office in (main.ts), and lets tests inject a runner, the wait or the concurrency. */
export function configureGit(options: { nonblocking?: boolean; runner?: GitRunner | null; waitMs?: number; concurrency?: number; changed?: (() => void) | null; pendingLimitMs?: number }): void {
  if (options.nonblocking !== undefined) nonblocking = options.nonblocking;
  if (options.pendingLimitMs !== undefined) pendingLimitMs = options.pendingLimitMs;
  if (options.runner !== undefined) runner = options.runner ?? defaultRunner;
  if (options.waitMs !== undefined) waitMs = options.waitMs;
  if (options.concurrency !== undefined) concurrency = Math.max(1, options.concurrency);
  if (options.changed !== undefined) changed = options.changed;
}
export function gitNonblocking(): boolean { return nonblocking; }

type Result = { ok: true; out: string } | { ok: false; message: string; stdout: string };
interface Entry { call: GitCall; immutable: boolean; done?: { at: number; result: Result }; flight?: { at: number; promise: Promise<void> }; usedAt: number }
const entries = new Map<string, Entry>();
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Reads whose answer is fixed by the commit ids they name: ls-tree, merge-base, patch-id, and a diff of two commits. */
function immutable(args: string[]): boolean {
  const plain = args[0] === "-c" ? args.slice(2) : args;
  const [command, ...rest] = plain;
  const shas = rest.filter((a) => SHA.test(a)).length;
  if (command === "ls-tree" || command === "merge-base") return shas >= 1 && rest.every((a) => a.startsWith("-") || SHA.test(a));
  if (command === "patch-id") return true; // keyed by its input, which is the diff of two commits
  if (command === "diff") return shas === 2 && rest.every((a) => a.startsWith("-") || SHA.test(a));
  return false;
}

interface Pass { horizon: number | null; decide: boolean; speculative: boolean; waits: Promise<void>[] }
let pass: Pass | null = null;
export function inPass(): boolean { return pass !== null; }
/**
 * Runs `fn` as if no pass were open: its git reads run as they did before. For the office's world, which a
 * pipeline request reads through and which remembers what git said about each folder (a fact being read must
 * not be remembered there as "not a checkout").
 */
export function outsidePass<T>(fn: () => T): T {
  const open = pass; pass = null;
  try { return fn(); } finally { pass = open; }
}
/** True while a decision is re-run in the background only to find the facts it needs: nothing it does is kept. */
export function speculating(): boolean { return pass?.speculative ?? false; }
/** For a catch that turns a git failure into "no": inside a decision, a fact being read is not a "no". */
export function rethrowPending(err: unknown): void {
  if (isGitPending(err) && pass?.decide) throw err;
}

// A few git processes at a time; a decision's reads go before a view's refreshes.
let running = 0;
const queued: Array<{ high: boolean; start: () => void }> = [];
function schedule<T>(high: boolean, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => { running++; work().then(resolve, reject).finally(() => { running--; next(); }); };
    if (running < concurrency) start();
    else if (high) { const i = queued.findIndex((q) => !q.high); queued.splice(i < 0 ? queued.length : i, 0, { high, start }); }
    else queued.push({ high, start });
  });
}
function next(): void { while (running < concurrency && queued.length) queued.shift()!.start(); }

let notify: ReturnType<typeof setTimeout> | null = null;
/** A refreshed fact that changed: the office redraws (coalesced), and its views read the new value. */
function announce(): void {
  if (notify || !changed) return;
  notify = setTimeout(() => { notify = null; try { changed?.(); } catch { /* a redraw never fails a read */ } }, 250);
  notify.unref?.();
}

function fetch(entry: Entry, horizon: number | null, high: boolean): Promise<void> {
  if (entry.flight && (horizon === null || entry.flight.at >= horizon)) return entry.flight.promise;
  const at = Date.now();
  const promise = schedule(high, () => runner(entry.call)).then(
    (out): Result => ({ ok: true, out }),
    (err): Result => ({ ok: false, message: err instanceof Error ? err.message : String(err), stdout: String((err as { stdout?: unknown })?.stdout ?? "") }),
  ).then((result) => {
    if (!entry.done || entry.done.at <= at) {
      const before = entry.done?.result;
      entry.done = { at, result };
      if (before && JSON.stringify(before) !== JSON.stringify(result)) announce();
    }
    if (entry.flight?.at === at) entry.flight = undefined;
  });
  entry.flight = { at, promise };
  return promise;
}

let inserts = 0;
function sweep(now: number): void {
  if (++inserts % 200) return;
  for (const [key, e] of entries) if (!e.flight && now - e.usedAt > 10 * 60_000) entries.delete(key);
  for (const [key, t] of tickets) if (now - t > TICKET_MS) tickets.delete(key);
  for (const [key, s] of stuck) if (now - s.last > TICKET_MS) stuck.delete(key);
}

/**
 * git's stdout for `call`. Outside a pass it runs synchronously, with execFileSync's own errors, as before.
 * Inside one it answers from what was read before (see the top of this file), throws GitFailed for a read that
 * failed, and GitPending, after starting the read, for a fact it may not use yet.
 */
export function gitOutput(call: GitCall, sync: () => string): string {
  if (!pass) return sync();
  const key = JSON.stringify([call.cwd, call.args, call.input ?? null]);
  const now = Date.now();
  let entry = entries.get(key);
  if (!entry) { entry = { call, immutable: immutable(call.args), usedAt: now }; entries.set(key, entry); sweep(now); }
  entry.usedAt = now;
  const done = entry.done;
  if (done && ((entry.immutable && done.result.ok) || pass.horizon === null || done.at >= pass.horizon)) {
    if (pass.horizon === null && !entry.immutable && now - done.at > REFRESH_MS) void fetch(entry, null, false);
    if (done.result.ok) return done.result.out;
    throw new GitFailed(done.result.message, done.result.stdout);
  }
  pass.waits.push(fetch(entry, pass.horizon, pass.decide));
  throw gitPending();
}

/** Runs `read` as one pass. `waits` is empty when it used only facts it may use; otherwise the reads it started. */
export function runPass<T>(read: () => T, options: { horizon: number | null; decide: boolean; speculative?: boolean }): { value?: T; error?: unknown; waits: Promise<void>[] } {
  if (pass) throw new Error("git passes do not nest");
  const current: Pass = { horizon: options.horizon, decide: options.decide, speculative: options.speculative ?? false, waits: [] };
  pass = current;
  try { return { value: read(), waits: current.waits }; }
  catch (error) { return { error, waits: current.waits }; }
  finally { pass = null; }
}

const tickets = new Map<string, number>();
/** When this decision was first asked, within TICKET_MS: the oldest read it may use. */
export function ticket(key: string): number {
  const now = Date.now(); const t = tickets.get(key);
  if (t !== undefined && now - t < TICKET_MS) return t;
  tickets.set(key, now);
  return now;
}
/** The decision was answered: the next time it is asked, it reads again. */
export function punch(key: string): void { tickets.delete(key); stuck.delete(key); }

// The safety net. A decision is meant to converge: its background rerun (settle) reads what it misses, and the
// retry is answered from that. Should it not (a git read that never comes back, a fact this file never lets the
// decision use, a bug here), an agent retrying would be refused git_pending forever with nothing saying why. So a
// question answered only git_pending for longer than pendingLimitMs is answered once with git read synchronously,
// as before this file existed: one slow request on a loaded machine is better than a decision that can never be
// made. It still decides only on facts read after it was asked, and a git that fails there is a real refusal,
// never git_pending. The net is per question, so a decision's key must be the same on every try: one keyed by
// something a refused try makes afresh (the item id of a submit that was rolled back) is a new question each time,
// is never caught here, and never converges either (store.ts bindItem once did exactly that for 45 minutes).
const stuck = new Map<string, { since: number; last: number }>();
/** This decision is answered git_pending. The first such answer starts its clock; a question not asked again
 * within TICKET_MS is a new one. */
export function refused(key: string): void {
  const now = Date.now(); const s = stuck.get(key);
  if (!s || now - s.last > TICKET_MS) stuck.set(key, { since: now, last: now });
  else s.last = now;
}
/** True when this decision has been answered only git_pending, while being asked, for longer than the bound. */
export function stalled(key: string): boolean {
  const s = stuck.get(key); const now = Date.now();
  return s !== undefined && now - s.last <= TICKET_MS && now - s.since > pendingLimitMs;
}

const jobs = new Map<string, Promise<void>>();
/**
 * Waits for `waits`, then calls `again` (a rerun of the pass, which returns the reads it still misses) until it
 * misses nothing, so facts that depend on other facts (a diff against a base read first) are found without a
 * caller retrying once per level. One job per key at a time; it resolves when a retry can be answered.
 */
export function settle(key: string, waits: Promise<void>[], again: () => Promise<void>[], done?: () => void): Promise<void> {
  const running = jobs.get(key);
  if (running) return running;
  const job = (async () => {
    let pending = waits;
    for (let round = 0; pending.length && round < 64; round++) {
      await Promise.all(pending);
      pending = again();
    }
    if (!pending.length) done?.();
  })().catch(() => { /* the next request reads again */ }).finally(() => { jobs.delete(key); });
  jobs.set(key, job);
  return job;
}

/**
 * Answers an office request: runs it, and when it misses git facts waits up to the office's wait (150 ms) for
 * them and runs it again. On an idle machine a request is answered as before; on a loaded one it answers its
 * fallback, or refuses with GitPending (503 git_pending), and the reads go on so that a retry is answered.
 */
export async function answerWithGit<T>(run: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return await run(); }
    catch (err) {
      if (!(isGitPending(err))) throw err;
      const left = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = left > 0 && await Promise.race([err.settled.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), left); })]);
      if (timer) clearTimeout(timer);
      if (!ready) { if (err.fallback !== undefined) return err.fallback as T; throw err; }
    }
  }
}

/** For tests: forget every fact, ticket and job. */
export function resetGitCache(): void { entries.clear(); tickets.clear(); jobs.clear(); stuck.clear(); }
