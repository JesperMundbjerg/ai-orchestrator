// Explicit, project-local workflow guardrails. The office, not these hooks, decides policy.
// This builtin-only module is copied into installed repos so moving the office checkout
// cannot silently disable an installed guard. No user/global harness config is written.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MARK = "review-inbox-pipeline-guard-v2";
const LEGACY_MARK = "review-inbox-pipeline-guard-v1";
const LOCAL = ".review-inbox-pipeline";
const OUTAGE = "Protected delivery blocked: the Review Inbox gate is unavailable or invalid. Restart the office and retry; editing, tests and local commits remain available.";
type Operation = "push" | "pr" | "merge" | "land" | "publish";
export type GuardedCommand = { command: string; operation: Operation; ref: string; candidateArgument?: number; checkoutArgument?: number };
/** A fix-comments lane that delivers its own fixes outside office runs, from exactly this checkout (a realpath). */
export type DeliveryLane = { name: string; checkout: string };
export type HookConfig = { marker: string; protectedRefs: string[]; guardedCommands: GuardedCommand[]; inboxCommand: string[]; lanes?: DeliveryLane[]; policyPaths?: string[] };
type Boundary = { repo: string; operation: Operation; ref: string; candidate: string; checkout?: string; run?: string; round?: string };
type Json = Record<string, any>;
type Change = { path: string; content: string | null; mode?: number; renameFrom?: string };
type Manifest = { _generated?: string; marker: string; prePush: string; backup: string; wrapper: string; policy?: HookConfig; settings: Record<string, { existed: boolean; hooks: boolean; pre: boolean }> };

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr?.trim() || result.error?.message || "failed"}`);
  return result.stdout.trim();
}
function maybeGit(repo: string, ...args: string[]): string {
  try { return git(repo, ...args); } catch { return ""; }
}
function refName(ref: string): string { return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`; }
function protectedRef(config: HookConfig, ref: string): boolean { return config.protectedRefs.includes(refName(ref)); }
function jsonFile(path: string): Json {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected a JSON object`);
  return value as Json;
}
function serialized(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
function quote(s: string): string { return `'${s.replaceAll("'", "'\\''")}'`; }
function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith(".." + "/") && r !== ".." && !isAbsolute(r));
}
// Check every ancestor before writing: project settings may not point into someone's home.
function safePath(root: string, path: string): void {
  if (!within(root, path)) throw new Error(`Not a repo-local path: ${path}`);
  for (let p = path; within(root, p); p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`Refusing symlinked hook path: ${p}`);
    if (p === root) break;
  }
}
function rejectGlobal(path: string): void {
  for (const dir of [".claude", ".pi", ".codex"]) {
    if (within(resolve(homedir(), dir), path)) throw new Error(`Never install into global harness settings: ${path}`);
  }
}

// Paths that change when a package manager upgrades node (Homebrew Cellar, nvm/volta/fnm/asdf, node-vX.Y.Z).
const VERSIONED_NODE = /\/(Cellar|versions|\.nvm|\.volta|\.fnm|\.asdf|\.nodenv)\/|\/node[@-]?v?\d+\.\d+\.\d+|\/v\d+\.\d+\.\d+\//;
/** The node path to write into hooks. A Claude hook that fails to start is non-blocking, so a path that
 * vanishes on `brew upgrade` would silently disable the guard. Prefer a non-versioned alias (Homebrew's
 * `opt/<formula>/bin/node`, then `<prefix>/bin/node`) that resolves to the running node; otherwise keep the
 * running node and say so. */
export function stableNode(execPath = process.execPath): { path: string; warning?: string } {
  const resolved = (p: string) => { try { return realpathSync(p); } catch { return ""; } };
  const real = resolved(execPath) || execPath;
  const candidates: string[] = [];
  const cellar = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(real);
  if (cellar) candidates.push(`${cellar[1]}/opt/${cellar[2]}/bin/node`, `${cellar[1]}/bin/node`);
  if (!VERSIONED_NODE.test(execPath)) candidates.push(execPath);
  const path = candidates.find((c) => resolved(c) === real);
  if (path) return { path };
  return { path: execPath, warning: `Using the running node ${execPath}: no non-versioned alias (such as /opt/homebrew/opt/node@24/bin/node) resolves to it, so a node upgrade or removal will make the Claude hook fail silently (hook failures do not block). Re-run install-hooks after upgrading node, or run it with a node reached through a stable path.` };
}
function generatedNote(node: string, repo: string): string {
  const note = `GENERATED by the Review Inbox pipeline installer; do not edit. Regenerate with: ${quote(node)} ${quote(fileURLToPath(new URL("../../bin/inbox", import.meta.url)))} pipeline install-hooks ${quote(repo)}`;
  return note.replace(/[\r\n]+/g, " "); // The note lives in single-line comments.
}
// A runner copy made by an earlier install carries our header; never stack headers when re-copying it.
const GENERATED_HEADER = /^\/\/ review-inbox-pipeline-guard-v\d+\n\/\/ GENERATED [^\n]*\n/;

/** Small shell lexer, not a shell evaluator. Literal argv and compound commands only.
 * Indirection/aliases are outside this guardrail's threat model. Never execute input. */
export function shellWords(command: string): string[][] {
  const parts: string[][] = []; let words: string[] = []; let word = ""; let started = false; let q = "";
  const flush = () => { if (started) words.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && q !== "'") { word += command[++i] ?? ""; started = true; continue; }
    if (q) { if (c === q) q = ""; else word += c; started = true; continue; }
    if (c === "'" || c === '"') { q = c; started = true; continue; }
    if (";&|\n()".includes(c)) { flush(); if (words.length) parts.push(words); words = []; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    word += c; started = true;
  }
  flush(); if (words.length) parts.push(words);
  return parts;
}
function option(words: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) for (const name of names) {
    if (words[i] === name) return words[i + 1];
    if (words[i]?.startsWith(name + "=")) return words[i]!.slice(name.length + 1);
  }
  return undefined;
}
/** Run/round named by the segment's own leading env assignments (`FOO=x env BAR=y cmd`); last one wins. */
function inlineRun(words: string[]): { run: string | undefined; round: string | undefined } {
  let run: string | undefined; let round: string | undefined;
  for (const word of words) {
    const m = /^(INBOX_PIPELINE_RUN|INBOX_PIPELINE_ROUND)=(.*)$/.exec(word);
    if (!m) continue;
    if (m[1] === "INBOX_PIPELINE_RUN") run = m[2]; else round = m[2];
  }
  return { run, round };
}
function sha(repo: string, rev: string): string {
  if (!rev || rev.startsWith("-")) throw new Error("Protected delivery needs a pinned candidate SHA");
  return git(repo, "rev-parse", "--verify", `${rev}^{commit}`);
}

/** Find literal boundaries, resolving cd / git -C and branch switches without changing Git. */
export function commandBoundaries(command: string, cwd: string, config: HookConfig): Boundary[] {
  const boundaries: Boundary[] = []; let repo = cwd; let branch = maybeGit(repo, "symbolic-ref", "--quiet", "HEAD");
  for (let words of shellWords(command)) {
    // Only this segment's prefix names a run: it must not leak to other segments of a compound command.
    const prefix = words; let skip = 0;
    while (words[skip] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[skip]!) || ["env", "command", "sudo"].includes(words[skip]!))) skip++;
    const named = inlineRun(prefix.slice(0, skip)); words = words.slice(skip);
    if (!words.length) continue;
    if (words[0] === "cd" && words[1]) { repo = resolve(repo, words[1]); branch = maybeGit(repo, "symbolic-ref", "--quiet", "HEAD"); continue; }
    const add = (operation: Operation, ref: string, rev: string, at = repo, checkout = at) => {
      if (!protectedRef(config, ref)) return;
      if ((named.run !== undefined && !/^[A-Za-z0-9._-]+$/.test(named.run)) || (named.round !== undefined && !/^[0-9]+$/.test(named.round))) throw new Error("INBOX_PIPELINE_RUN / INBOX_PIPELINE_ROUND in the command must be literal values (a run id and a number), not shell expansions");
      boundaries.push({ repo: at, operation, ref: refName(ref), candidate: sha(at, rev), checkout, ...named });
    };
    if (basename(words[0]!) === "git") {
      let at = repo; let i = 1; let contextOverride = false;
      while (words[i]?.startsWith("-")) {
        if (words[i] === "-C") { at = resolve(at, words[i + 1] ?? ""); i += 2; }
        else if (["-c", "--git-dir", "--work-tree"].includes(words[i]!)) { contextOverride = true; i += 2; }
        else i++;
      }
      const verb = words[i++]; const args = words.slice(i);
      if (contextOverride && ["push", "merge"].includes(verb ?? "")) throw new Error("Git context/config overrides require a separate guarded delivery command");
      const current = at === repo ? branch : maybeGit(at, "symbolic-ref", "--quiet", "HEAD");
      if (["checkout", "switch"].includes(verb ?? "")) {
        if (at === repo && args[0] && !args[0].startsWith("-")) branch = refName(args[0]);
        else if (at === repo) branch = ""; // Unknown target: subsequent merge is conservative.
      }
      if (verb === "push") {
        // pre-push supplies authoritative expanded refspecs, including --all / --mirror.
        // Preflight explicit refspecs; unresolved/default pushes are checked conservatively.
        const positional = args.filter((a) => !a.startsWith("-"));
        const specs = positional.slice(1);
        if (specs.length && !args.includes("--all") && !args.includes("--mirror")) {
          for (const spec of specs) {
            const [src, target] = spec.replace(/^\+/, "").split(":");
            const dest = target ?? src!;
            if (dest.includes("*")) { for (const ref of config.protectedRefs) add("push", ref, "HEAD", at); }
            else if (protectedRef(config, dest)) {
              if (!src || args.includes("--delete") || args.includes("-d")) throw new Error("Deleting a protected ref is not pipeline delivery");
              add("push", dest, src, at);
            }
          }
        } else {
          const upstream = maybeGit(at, "rev-parse", "--symbolic-full-name", "@{upstream}");
          const dest = upstream.replace(/^refs\/remotes\/[^/]+\//, "refs/heads/") || current;
          if (dest && !args.includes("--all") && !args.includes("--mirror")) add("push", dest, "HEAD", at);
          else for (const ref of config.protectedRefs) add("push", ref, "HEAD", at);
        }
      }
      if (verb === "merge" && !args.some((a) => ["--abort", "--quit"].includes(a))) {
        const targets = current ? [current] : config.protectedRefs;
        if (targets.some((t) => protectedRef(config, t))) {
          if (args.includes("--continue")) throw new Error("Protected merge continuation needs a pinned integration candidate and the canonical guarded landing command");
          const sources = args.filter((a) => !a.startsWith("-"));
          if (sources.length !== 1 || args.some((a) => ["--squash", "--no-commit", "--no-ff"].includes(a))) throw new Error("Protected merge requires one pinned fast-forward candidate; use the canonical guarded landing command for integration merges");
          const candidate = sha(at, sources[0]!);
          if (spawnSync("git", ["-C", at, "merge-base", "--is-ancestor", current || "HEAD", candidate]).status !== 0) throw new Error("Protected non-fast-forward merge needs the canonical guarded landing command and its pinned integration candidate");
          for (const ref of targets) add("merge", ref, candidate, at);
        }
      }
    }
    if (basename(words[0]!) === "gh" && words[1] === "pr" && ["create", "merge"].includes(words[2] ?? "")) {
      if (option(words, "--repo", "-R")) throw new Error("Cross-repository PR delivery needs an explicit repository-bound release procedure");
      const base = option(words, "--base", "-B") || maybeGit(repo, "symbolic-ref", "refs/remotes/origin/HEAD").replace(/^refs\/remotes\/[^/]+\//, "") || "main";
      if (words[2] === "merge") throw new Error("PR merge requires an explicit pinned release boundary; use the office's release procedure");
      add("pr", base, option(words, "--head", "-H") || "HEAD");
    }
    for (const guarded of config.guardedCommands) {
      const prefix = shellWords(guarded.command)[0]!;
      // Script paths may be absolute (FysikLab calls the main checkout's script).
      if (prefix.every((p, i) => words[i] === p || (p.includes("/") && basename(words[i] ?? "") === basename(p)))) {
        const rev = guarded.candidateArgument === undefined ? (guarded.operation === "publish" ? refName(guarded.ref) : "HEAD") : words[prefix.length + guarded.candidateArgument];
        if (!rev) throw new Error(`Guarded ${guarded.operation} needs a pinned candidate`);
        const checkout = guarded.checkoutArgument === undefined ? "." : words[prefix.length + guarded.checkoutArgument];
        if (!checkout) throw new Error(`Guarded ${guarded.operation} needs its candidate checkout`);
        add(guarded.operation, guarded.ref, rev, repo, resolve(repo, checkout));
      }
    }
  }
  return boundaries;
}

function gate(boundary: Boundary, config: HookConfig, identity: Json): string | null {
  const args = ["pipeline", "gate", "--repo", boundary.repo, "--operation", boundary.operation, "--ref", boundary.ref, "--candidate", boundary.candidate];
  // Harness tool hooks run in the harness's environment, so the guarded command's own env assignments
  // name the run; process env is the fallback (and what a Git-run pre-push inherits from `git push`).
  const run = boundary.run || process.env.INBOX_PIPELINE_RUN;
  // A round belongs to its run: never pair an inline run with the process env's round for another run.
  const round = boundary.round || (!boundary.run || boundary.run === process.env.INBOX_PIPELINE_RUN ? process.env.INBOX_PIPELINE_ROUND : undefined);
  if (run) args.push("--run", run);
  if (round) args.push("--round", round);
  if (identity.harness && identity.session) args.push("--harness", identity.harness, "--session", identity.session);
  const [exe, ...prefix] = config.inboxCommand;
  const result = spawnSync(exe!, [...prefix, ...args], { cwd: boundary.repo, encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024 });
  if (result.status === 0 && !result.error) return null;
  if (result.status === 1) {
    const reason = result.stderr?.trim() || result.stdout?.trim() || "Protected delivery refused by the office pipeline gate.";
    const hint = run ? "" : `\nName the run in the guarded command itself: prefix it with INBOX_PIPELINE_RUN=<run> (and INBOX_PIPELINE_ROUND=<n> if the gate needs a round), e.g. INBOX_PIPELINE_RUN=<run> ${boundary.operation === "push" ? "git push …" : "node …/worktree-sync.mjs land …"}. A separate export or an earlier command segment does not carry over.`;
    return `${reason}${hint}\nIf the office is unavailable: Restart the office and retry; editing, tests and local commits remain available.`;
  }
  return `${OUTAGE}${result.stderr?.trim() ? `\n${result.stderr.trim()}` : ""}`;
}
// Lane delivery: a declared fix-comments lane lands its own fixes outside office runs. The class comes
// from the candidate checkout, never from a missing run variable; everything else is run (or waiver)
// delivery and asks the office. Advisory like the rest of these hooks: it stops mistakes, not an owner.
/** The guard's own files and the adapter. Lanes never deliver these; a founder waiver can. */
export const POLICY_PATHS = ["orchestrator.json", ".review-inbox-pipeline/**", ".claude/hooks/review-inbox-pipeline.mjs", ".pi/extensions/review-inbox-pipeline.ts", ".codex/hooks.json"];
const LANE_OPERATIONS: Operation[] = ["push", "land", "publish"];
function laneOf(config: HookConfig, checkout: string | undefined): DeliveryLane | undefined {
  if (!checkout || !Array.isArray(config.lanes)) return undefined;
  let real: string;
  try { real = realpathSync(checkout); } catch { return undefined; } // Unresolvable: never a lane.
  const top = maybeGit(real, "rev-parse", "--show-toplevel");
  const matches = config.lanes.filter((l) => l && typeof l.checkout === "string" && l.checkout === (top ? realpathSync(top) : real));
  return matches.length === 1 ? matches[0] : undefined; // Ambiguous configuration is not a lane.
}
function policyMatch(path: string, patterns: string[]): boolean {
  return patterns.some((p) => p.endsWith("/**") ? path.startsWith(p.slice(0, -2)) : path === p);
}
/** Paths this candidate brings to `ref` beyond what `base` already has; null if Git cannot say (fail closed). */
function touched(repo: string, ref: string, candidate: string, base?: string): string[] | null {
  const branch = ref.replace(/^refs\/heads\//, "");
  const from = base ?? (maybeGit(repo, "rev-parse", "--verify", `refs/remotes/origin/${branch}`) || maybeGit(repo, "rev-parse", "--verify", `refs/heads/${branch}`));
  if (!from) return null;
  try { return git(repo, "diff", "--no-renames", "--name-only", `${from}...${candidate}`).split("\n").filter(Boolean); } catch { return null; }
}
function policyClean(config: HookConfig, repo: string, ref: string, candidate: string, base?: string): boolean {
  const paths = touched(repo, ref, candidate, base);
  return paths !== null && !paths.some((p) => policyMatch(p, [...POLICY_PATHS, ...(config.policyPaths ?? [])]));
}
function landingRecord(repo: string, candidate: string): string | null {
  const common = maybeGit(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common && /^[0-9a-f]{40,64}$/.test(candidate) ? join(common, "review-inbox-pipeline", "lane-landings", candidate) : null;
}
/** null: not lane delivery, ask the office. "": allowed as lane delivery. Otherwise the refusal. */
function laneDecision(boundary: Boundary, config: HookConfig, run: string | undefined, base?: string): string | null {
  if (!LANE_OPERATIONS.includes(boundary.operation)) return null;
  const lane = laneOf(config, boundary.checkout);
  const record = landingRecord(boundary.repo, boundary.candidate);
  if (lane) {
    if (run) return `Protected delivery blocked: ${lane.name} is a lane checkout, which delivers outside office runs. Deliver run ${run} from the team's own checkout.`;
    if (spawnSync("git", ["-C", lane.checkout, "merge-base", "--is-ancestor", boundary.candidate, "HEAD"]).status !== 0) return `Protected delivery blocked: ${boundary.candidate} is not checked out in lane ${lane.name}'s checkout.`;
    if (!policyClean(config, boundary.repo, boundary.ref, boundary.candidate, base)) return null; // Policy files: only a founder waiver.
    if (record) try { mkdirSync(dirname(record), { recursive: true }); writeFileSync(record, serialized({ lane: lane.name, ref: boundary.ref, at: new Date().toISOString() })); } catch { /* Publication then needs a run or waiver. */ }
    return "";
  }
  // Publication of a lane's landed commit (Git's pre-push, or a publish retry) from the main checkout.
  if (run || !record || !existsSync(record)) return null;
  try { if (jsonFile(record).ref !== boundary.ref) return null; } catch { return null; }
  return policyClean(config, boundary.repo, boundary.ref, boundary.candidate, base) ? "" : null;
}
function decide(boundary: Boundary, config: HookConfig, identity: Json, base?: string): string | null {
  const lane = laneDecision(boundary, config, boundary.run || process.env.INBOX_PIPELINE_RUN, base);
  if (lane === "") return null;
  return lane ?? gate(boundary, config, identity);
}
export function guardTool(config: HookConfig, input: Json, cwd: string, harness: string, session = ""): string | null {
  const toolInput = input.tool_input ?? input.input ?? {};
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command !== "string" && !Array.isArray(command)) return null;
  try {
    for (const boundary of commandBoundaries(Array.isArray(command) ? command.map(quote).join(" ") : command, toolInput.cwd || toolInput.workdir || input.cwd || cwd, config)) {
      const reason = decide(boundary, config, { harness, session: session || input.session_id });
      if (reason) return reason;
    }
    return null;
  } catch (err) { return `Protected delivery blocked: ${(err as Error).message}`; }
}
function identity(): Json {
  if (process.env.CLAUDE_CODE_SESSION_ID) return { harness: "claude", session: process.env.CLAUDE_CODE_SESSION_ID };
  if (process.env.CODEX_THREAD_ID) return { harness: "codex", session: process.env.CODEX_THREAD_ID };
  if (process.env.PI_SESSION_FILE) return { harness: "pi", session: process.env.PI_SESSION_FILE };
  return {};
}
export function guardPrePush(config: HookConfig, input: string, cwd: string): string | null {
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/); const candidate = fields[1]; const ref = fields[2];
    if (fields.length !== 4 || !candidate || !ref) return "Protected delivery blocked: malformed pre-push input";
    if (!protectedRef(config, ref)) continue;
    if (/^0+$/.test(candidate)) return "Protected delivery blocked: deleting a protected ref is not delivery";
    const remote = fields[3]!;
    const reason = decide({ repo: cwd, operation: "push", ref, candidate, checkout: cwd }, config, identity(), /^0+$/.test(remote) ? undefined : remote);
    if (reason) return reason;
  }
  return null;
}

function configured(repo: string, inboxCommand: string[]): HookConfig {
  const main = git(repo, "worktree", "list", "--porcelain").split("\n")[0]!.slice("worktree ".length);
  const adapter = jsonFile(join(main, "orchestrator.json")); const hooks = adapter.pipelineHooks ?? {};
  const refs = [...new Set(["dev", "main", "master", adapter.integrationBranch, ...(hooks.protectedRefs ?? [])].filter(Boolean).map(refName))];
  if (!refs.every((r) => /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(r))) throw new Error("pipelineHooks.protectedRefs must name literal branch refs");
  const commands: GuardedCommand[] = hooks.guardedCommands ?? [];
  if (!Array.isArray(commands) || !commands.every((c) => c && typeof c.command === "string" && shellWords(c.command).length === 1 && shellWords(c.command)[0]!.length > 0 && ["land", "publish", "push", "pr", "merge"].includes(c.operation) && typeof c.ref === "string" && (c.candidateArgument === undefined || (Number.isInteger(c.candidateArgument) && c.candidateArgument >= 0)))) throw new Error("Invalid pipelineHooks.guardedCommands");
  for (const c of commands) if (!refs.includes(refName(c.ref))) refs.push(refName(c.ref));
  if (adapter.land || adapter.project === "fysiklab") {
    // `land CHECKOUT SHA`: the checkout decides whether this is a lane's own delivery.
    commands.push({ command: "node .claude/hooks/worktree-sync.mjs land", operation: "land", ref: adapter.integrationBranch || "dev", candidateArgument: 1, checkoutArgument: 0 });
    commands.push({ command: "node .claude/hooks/worktree-sync.mjs publish", operation: "publish", ref: adapter.integrationBranch || "dev" });
    // Accept a directly executable script as well as the usual node invocation.
    commands.push({ command: ".claude/hooks/worktree-sync.mjs land", operation: "land", ref: adapter.integrationBranch || "dev", candidateArgument: 1, checkoutArgument: 0 });
    commands.push({ command: ".claude/hooks/worktree-sync.mjs publish", operation: "publish", ref: adapter.integrationBranch || "dev" });
  }
  return { marker: MARK, protectedRefs: refs, guardedCommands: commands, inboxCommand, ...laneDelivery(main, adapter, hooks.laneDelivery) };
}
/** `pipelineHooks.laneDelivery: { lanes: ["einstein"], policyPaths: [...] }` names which of the adapter's
 * `lanes[]` deliver outside office runs, from their declared worktree. The main checkout never does. */
function laneDelivery(main: string, adapter: Json, declared: unknown): { lanes: DeliveryLane[]; policyPaths: string[] } {
  if (declared === undefined) return { lanes: [], policyPaths: [] };
  const d = declared as Json;
  if (!d || typeof d !== "object" || Array.isArray(d) || !Array.isArray(d.lanes ?? []) || !Array.isArray(d.policyPaths ?? [])) throw new Error("pipelineHooks.laneDelivery must be { lanes: [names], policyPaths: [paths] }");
  const policyPaths: string[] = d.policyPaths ?? [];
  if (!policyPaths.every((p) => typeof p === "string" && p && !p.startsWith("/") && !p.includes("..") && !p.slice(0, -3).includes("*"))) throw new Error("pipelineHooks.laneDelivery.policyPaths must be repo paths, optionally ending in /**");
  const known: Json[] = Array.isArray(adapter.lanes) ? adapter.lanes : [];
  const mainReal = realpathSync(main);
  const lanes = (d.lanes as unknown[]).map((name) => {
    const lane = known.find((l) => l && l.name === name);
    if (typeof name !== "string" || !lane || typeof lane.worktree !== "string") throw new Error(`pipelineHooks.laneDelivery: "${String(name)}" is not a lane with a worktree in orchestrator.json`);
    let checkout: string;
    try { checkout = realpathSync(resolve(main, lane.worktree)); } catch { return null; } // Not on this machine: not a lane here.
    if (checkout === mainReal) throw new Error(`pipelineHooks.laneDelivery: lane ${name} is the main checkout, which delivers only through runs or waivers`);
    if (realpathSync(git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")) !== realpathSync(git(main, "rev-parse", "--path-format=absolute", "--git-common-dir"))) throw new Error(`pipelineHooks.laneDelivery: lane ${name}'s worktree belongs to another repository`);
    return { name, checkout };
  }).filter((l): l is DeliveryLane => l !== null);
  if (new Set(lanes.map((l) => l.checkout)).size !== lanes.length) throw new Error("pipelineHooks.laneDelivery: two lanes share one worktree");
  return { lanes, policyPaths };
}
function mergeSettings(path: string, command: string, remove: boolean, original: Manifest["settings"][string] | undefined, owns: (command: unknown) => boolean): string | null {
  const settings = jsonFile(path);
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) throw new Error(`${path}: hooks must be an object`);
  const hooks = settings.hooks ?? {};
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse)) throw new Error(`${path}: PreToolUse must be an array`);
  const pre: Json[] = [];
  for (const group of hooks.PreToolUse ?? []) {
    if (!group || !Array.isArray(group.hooks)) throw new Error(`${path}: invalid PreToolUse hook group`);
    const remaining = group.hooks.filter((h: Json) => h.command !== command && !owns(h.command));
    if (remaining.length || !group.hooks.length) pre.push({ ...group, hooks: remaining });
  }
  if (!remove) pre.push({ matcher: ".*", hooks: [{ type: "command", command, timeout: 15 }] });
  if (pre.length || original?.pre) hooks.PreToolUse = pre; else delete hooks.PreToolUse;
  if (Object.keys(hooks).length || original?.hooks) settings.hooks = hooks; else delete settings.hooks;
  return remove && !original?.existed && !Object.keys(settings).length ? null : serialized(settings);
}

/** Standalone committed entrypoints: only the runtime string import reaches ignored metadata.
 * Embed the same read-only boundary parser plus the installed policy, so a broken/missing
 * runner or config cannot disable custom refs/commands or block unrelated work.
 * Node's erasable-TS loader makes toString() builtin-only JavaScript here. */
function toolEntrypoint(runner: string, configPath: string, config: HookConfig, pi: boolean, note: string): string {
  const parser = [git, maybeGit, refName, protectedRef, quote, shellWords, option, inlineRun, sha, commandBoundaries].map(fn => fn.toString()).join("\n");
  const types = pi ? `type Config = { marker: string; protectedRefs: string[]; guardedCommands: { command: string; operation: string; ref: string; candidateArgument?: number; checkoutArgument?: number }[]; inboxCommand: string[]; lanes?: { name: string; checkout: string }[]; policyPaths?: string[] };
type Input = { tool_input?: { command?: string | string[]; cmd?: string | string[]; cwd?: string; workdir?: string }; input?: Input['tool_input']; cwd?: string; session_id?: string };
type Guard = (config: typeof POLICY, input: Input, cwd: string, harness: string, session?: string) => string | null;
type Context = { cwd: string; sessionManager: { getSessionFile(): string | undefined } };
type Pi = { on(event: 'tool_call', handler: (event: Input, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void };
` : "";
  return `// ${MARK}
// ${note}
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
const RUNNER_PATH = ${JSON.stringify(runner)};
const CONFIG_PATH = ${JSON.stringify(configPath)};
const POLICY${pi ? ": Config" : ""} = ${JSON.stringify(config)};
${types}${parser}
const MISSING = 'Protected delivery blocked: pipeline guard runner missing at ' + RUNNER_PATH + '; reinstall pipeline hooks (runner or config missing or failed to load). Editing, tests and local commits remain available.';
function loadConfig() {
  if (!existsSync(RUNNER_PATH)) throw new Error('missing runner');
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (![POLICY.marker, ${JSON.stringify(LEGACY_MARK)}].includes(config.marker) || !Array.isArray(config.protectedRefs) || !config.protectedRefs.every((ref${pi ? ": unknown" : ""}) => typeof ref === 'string') || !Array.isArray(config.guardedCommands) || !config.guardedCommands.every((c${pi ? ": typeof POLICY.guardedCommands[number]" : ""}) => c && typeof c.command === 'string' && typeof c.ref === 'string' && ['push', 'pr', 'merge', 'land', 'publish'].includes(c.operation) && (c.candidateArgument === undefined || (Number.isInteger(c.candidateArgument) && c.candidateArgument >= 0))) || !Array.isArray(config.inboxCommand) || !config.inboxCommand.length || !config.inboxCommand.every((arg${pi ? ": unknown" : ""}) => typeof arg === 'string')) throw new Error('invalid pipeline guard config');
  return config;
}
async function reasonFor(input${pi ? ": Input" : ""}, cwd${pi ? ": string" : ""}, harness${pi ? ": string" : ""}, session = '')${pi ? ": Promise<string | null>" : ""} {
  try {
    const config = loadConfig();
    const runner = RUNNER_PATH;
    const { guardTool }${pi ? ": { guardTool: Guard }" : ""} = await import(runner);
    if (typeof guardTool !== 'function') throw new Error('invalid pipeline guard runner');
    return guardTool(config, input, cwd, harness, session);
  } catch {
    const toolInput = input.tool_input ?? input.input ?? {};
    const command = toolInput.command ?? toolInput.cmd;
    if (typeof command !== 'string' && !Array.isArray(command)) return null;
    const reason = MISSING;
    try {
      const boundaries = commandBoundaries(Array.isArray(command) ? command.map(quote).join(' ') : command, toolInput.cwd || toolInput.workdir || input.cwd || cwd, POLICY);
      return boundaries.length ? reason : null;
    } catch { return reason; }
  }
}
${pi ? `export default function (pi: Pi) {
  pi.on('tool_call', async (event, ctx) => {
    const reason = await reasonFor(event, ctx.cwd, 'pi', ctx.sessionManager.getSessionFile() || '');
    if (reason) return { block: true, reason };
  });
}` : `const raw = readFileSync(0, 'utf8');
if (process.argv[2] === 'pre-push') {
  let reason;
  try {
    const config = loadConfig();
    const runner = RUNNER_PATH;
    const { guardPrePush } = await import(runner);
    if (typeof guardPrePush !== 'function') throw new Error('invalid pipeline guard runner');
    reason = guardPrePush(config, raw, process.cwd());
  } catch {
    reason = raw.trim().split('\\n').filter(Boolean).some(line => {
      const fields = line.trim().split(/\\s+/);
      return fields.length !== 4 || protectedRef(POLICY, fields[2]);
    }) ? MISSING : null;
  }
  if (reason) { console.error(reason); process.exitCode = 1; }
} else {
const input = JSON.parse(raw);
const reason = await reasonFor(input, process.cwd(), process.argv[2] === 'codex' ? 'codex' : 'claude');
// {} preserves the harness's ordinary approval policy; never auto-allow.
console.log(JSON.stringify(reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {}));
}`}
`;
}

/** Validate a complete plan before touching disk. Existing unrelated settings are retained. */
export function installHooks(path: string, options: { dryRun?: boolean; uninstall?: boolean; inboxCommand?: string[]; node?: string; warn?: (message: string) => void } = {}): Change[] {
  const repo = realpathSync(git(resolve(path), "rev-parse", "--show-toplevel")); rejectGlobal(repo);
  const local = join(repo, LOCAL); const manifestPath = join(local, "manifest.json");
  const prior = existsSync(manifestPath) ? jsonFile(manifestPath) as Manifest : undefined;
  if (prior && ![MARK, LEGACY_MARK].includes(prior.marker)) throw new Error("Unrecognised hook manifest; refusing to overwrite");
  if (!prior && existsSync(local)) throw new Error(`${local} exists without our manifest; refusing to overwrite`);
  const runner = join(local, "pipeline-hooks.ts"); const configPath = join(local, "config.json");
  const settingsPaths = [join(repo, ".claude/settings.json"), join(repo, ".codex/hooks.json")];
  const pi = join(repo, ".pi/extensions/review-inbox-pipeline.ts");
  const toolHook = join(repo, ".claude/hooks/review-inbox-pipeline.mjs");
  let prePush = prior?.prePush || resolve(repo, git(repo, "rev-parse", "--git-path", "hooks/pre-push"));
  prePush = resolve(prePush); rejectGlobal(prePush);
  // A hooksPath outside the checkout is explicit git configuration; honour it, but not symlinks.
  const common = realpathSync(resolve(repo, git(repo, "rev-parse", "--git-common-dir")));
  for (const p of [runner, manifestPath, configPath, ...settingsPaths, pi, toolHook]) safePath(repo, p);
  if (existsSync(prePush) && lstatSync(prePush).isSymbolicLink()) throw new Error(`Refusing symlinked pre-push hook: ${prePush}`);
  const backup = prior?.backup || `${prePush}.review-inbox-original-${createHash("sha256").update(repo).digest("hex").slice(0, 12)}`;
  let node = options.node;
  if (!node) { const stable = stableNode(); node = stable.path; if (stable.warning && !options.uninstall) options.warn?.(stable.warning); }
  const note = generatedNote(node, repo);
  // Whichever node an earlier install wrote, our own entries are replaced rather than duplicated.
  const owns = (command: unknown): boolean => {
    if (typeof command !== "string") return false;
    const words = shellWords(command)[0] ?? [];
    return (words.length === 4 && words[1] === runner && ["claude", "codex"].includes(words[2]!) && words[3] === configPath)
      || (words.length === 3 && words[1] === toolHook && ["claude", "codex"].includes(words[2]!));
  };
  const config = options.uninstall ? undefined : configured(repo, options.inboxCommand ?? [node, fileURLToPath(new URL("../../bin/inbox", import.meta.url))]);
  // Re-install may add protection, never silently remove an installed boundary.
  if (prior && config) {
    // v2 retains policy in the manifest too, so reinstall can repair absent/corrupt
    // runtime config without silently dropping custom protection.
    const previous = prior.policy ?? jsonFile(configPath) as HookConfig;
    if (!Array.isArray(previous.protectedRefs) || !Array.isArray(previous.guardedCommands)) throw new Error("Installed pipeline policy missing; restore it or explicitly uninstall/reinstall");
    config.protectedRefs = [...new Set([...previous.protectedRefs, ...config.protectedRefs])];
    // The same boundary may gain a checkoutArgument (lane classification); it is never dropped.
    config.guardedCommands = [...new Map([...previous.guardedCommands, ...config.guardedCommands].map((c) => [JSON.stringify([c.command, c.operation, c.ref, c.candidateArgument]), c])).values()];
    // Lanes are a permission: only the current adapter grants them. Policy paths only accumulate.
    config.policyPaths = [...new Set([...(previous.policyPaths ?? []), ...(config.policyPaths ?? [])])];
  }
  const changes: Change[] = [];
  const settings: Manifest["settings"] = prior?.settings ?? {};
  for (const [i, p] of settingsPaths.entries()) {
    const s = jsonFile(p);
    settings[p] ??= { existed: existsSync(p), hooks: s.hooks !== undefined, pre: s.hooks?.PreToolUse !== undefined };
    if (!options.uninstall || existsSync(p)) changes.push({ path: p, content: mergeSettings(p, `${quote(node)} ${quote(toolHook)} ${i ? "codex" : "claude"}`, !!options.uninstall, settings[p], owns) });
  }
  for (const p of [pi, toolHook]) {
    if (existsSync(p) && ![MARK, LEGACY_MARK].some(mark => readFileSync(p, "utf8").startsWith(`// ${mark}\n`))) throw new Error(`Refusing to replace another pipeline entrypoint: ${p}`);
  }
  const originalExecutable = existsSync(backup) ? !!(statSync(backup).mode & 0o111) : !prior && existsSync(prePush) && !!(statSync(prePush).mode & 0o111);
  const wrapper = `#!/bin/sh\n# ${MARK}\n# ${note}\ninput=$(mktemp) || exit 1\ntrap 'rm -f "$input"' EXIT HUP INT TERM\ncat > "$input"\n${quote(node)} ${quote(toolHook)} pre-push < "$input" || exit $?\n${originalExecutable ? `${quote(backup)} "$@" < "$input"\nexit $?` : "exit 0"}\n`;
  const current = existsSync(prePush) ? readFileSync(prePush, "utf8") : "";
  if (prior && current !== prior.wrapper) throw new Error(`Pre-push changed since installation; keep it and resolve manually: ${prePush}`);
  if (!prior && existsSync(backup)) throw new Error(`A pipeline backup already owns ${backup}; resolve it before installing`);
  if (options.uninstall) {
    if (!prior) return [];
    changes.push({ path: pi, content: null }, { path: toolHook, content: null });
    changes.push(existsSync(backup) ? { path: prePush, content: null, renameFrom: backup } : { path: prePush, content: null });
    for (const p of [runner, configPath, manifestPath]) changes.push({ path: p, content: null });
  } else {
    changes.push({ path: runner, content: `// ${MARK}\n// ${note}\n${readFileSync(fileURLToPath(import.meta.url), "utf8").replace(GENERATED_HEADER, "")}` });
    changes.push({ path: configPath, content: serialized({ _generated: note, ...config }) }, { path: pi, content: toolEntrypoint(runner, configPath, config!, true, note) }, { path: toolHook, content: toolEntrypoint(runner, configPath, config!, false, note) });
    if (!prior && existsSync(prePush)) changes.push({ path: backup, content: null, renameFrom: prePush });
    changes.push({ path: prePush, content: wrapper, mode: 0o755 });
    changes.push({ path: manifestPath, content: serialized({ _generated: note, marker: MARK, prePush, backup, wrapper, policy: config, settings } satisfies Manifest) });
  }
  // git common dirs (linked worktrees) and configured hooksPath may be outside repo;
  // no writes to any global harness config are permitted even through parent symlinks.
  for (const c of changes) {
    rejectGlobal(c.path);
    let ancestor = c.path;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (ancestor !== c.path && !statSync(ancestor).isDirectory()) throw new Error(`Hook parent is not a directory: ${ancestor}`);
    const resolved = resolve(realpathSync(ancestor), relative(ancestor, c.path)); rejectGlobal(resolved);
    if (within(repo, c.path)) safePath(repo, c.path);
    if (within(common, c.path)) safePath(common, c.path);
  }
  if (!options.dryRun) for (const change of changes) {
    if (change.renameFrom) { mkdirSync(dirname(change.path), { recursive: true }); renameSync(change.renameFrom, change.path); }
    else if (change.content === null) { if (existsSync(change.path)) unlinkSync(change.path); }
    else {
      mkdirSync(dirname(change.path), { recursive: true });
      if (!existsSync(change.path) || readFileSync(change.path, "utf8") !== change.content) {
        const temp = `${change.path}.tmp-${process.pid}`;
        writeFileSync(temp, change.content, { mode: change.mode ?? (existsSync(change.path) ? statSync(change.path).mode & 0o777 : 0o644) });
        renameSync(temp, change.path);
      }
      if (change.mode) chmodSync(change.path, change.mode);
    }
  }
  if (!options.dryRun && options.uninstall && prior) {
    try { rmdirSync(local); } catch { /* Keep unrelated files added after installation. */ }
  }
  return changes;
}

export function installHooksCommand(argv: string[]): void {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: { "dry-run": { type: "boolean" }, uninstall: { type: "boolean" } } });
  if (parsed.positionals.length !== 1) throw new Error("Usage: inbox pipeline install-hooks <repo-or-worktree> [--dry-run] [--uninstall]");
  const changes = installHooks(parsed.positionals[0]!, { dryRun: parsed.values["dry-run"], uninstall: parsed.values.uninstall, warn: (message) => console.error(`warning: ${message}`) });
  for (const change of changes) console.log(`${parsed.values["dry-run"] ? "Would " : ""}${change.renameFrom ? "restore/chain" : change.content === null ? "remove" : "write"} ${change.path}`);
  if (!parsed.values.uninstall) console.log("Trust/reload project hooks in each harness before delivery. Preflight is not delivery evidence; protected pre-push rechecks every ref.");
}

function hookMain(): void {
  const [mode, configPath] = process.argv.slice(2);
  if (!configPath) throw new Error(OUTAGE);
  const config = jsonFile(configPath) as HookConfig;
  if (![MARK, LEGACY_MARK].includes(config.marker) || !Array.isArray(config.protectedRefs) || !config.inboxCommand?.length) throw new Error(OUTAGE);
  const raw = readFileSync(0, "utf8");
  if (mode === "pre-push") {
    const reason = guardPrePush(config, raw, process.cwd());
    if (reason) { console.error(reason); process.exitCode = 1; }
    return;
  }
  const input = JSON.parse(raw) as Json;
  const reason = guardTool(config, input, process.cwd(), mode === "codex" ? "codex" : "claude");
  // {} leaves ordinary tools and their approval policy untouched (never auto-allow).
  console.log(serialized(reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } : {}).trim());
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { hookMain(); } catch (err) { console.error(`${OUTAGE}\n${(err as Error).message}`); process.exitCode = 2; }
}
