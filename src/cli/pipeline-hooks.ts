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

const MARK = "review-inbox-pipeline-guard-v1";
const LOCAL = ".review-inbox-pipeline";
const OUTAGE = "Protected delivery blocked: the Review Inbox gate is unavailable or invalid. Restart the office and retry; editing, tests and local commits remain available.";
type Operation = "push" | "pr" | "merge" | "land" | "publish";
export type GuardedCommand = { command: string; operation: Operation; ref: string; candidateArgument?: number };
export type HookConfig = { marker: string; protectedRefs: string[]; guardedCommands: GuardedCommand[]; inboxCommand: string[] };
type Boundary = { repo: string; operation: Operation; ref: string; candidate: string };
type Json = Record<string, any>;
type Change = { path: string; content: string | null; mode?: number; renameFrom?: string };
type Manifest = { marker: string; prePush: string; backup: string; wrapper: string; settings: Record<string, { existed: boolean; hooks: boolean; pre: boolean }> };

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
function sha(repo: string, rev: string): string {
  if (!rev || rev.startsWith("-")) throw new Error("Protected delivery needs a pinned candidate SHA");
  return git(repo, "rev-parse", "--verify", `${rev}^{commit}`);
}

/** Find literal boundaries, resolving cd / git -C and branch switches without changing Git. */
export function commandBoundaries(command: string, cwd: string, config: HookConfig): Boundary[] {
  const boundaries: Boundary[] = []; let repo = cwd; let branch = maybeGit(repo, "symbolic-ref", "--quiet", "HEAD");
  for (let words of shellWords(command)) {
    while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ["env", "command", "sudo"].includes(words[0]))) words = words.slice(1);
    if (!words.length) continue;
    if (words[0] === "cd" && words[1]) { repo = resolve(repo, words[1]); branch = maybeGit(repo, "symbolic-ref", "--quiet", "HEAD"); continue; }
    const add = (operation: Operation, ref: string, rev: string, at = repo) => {
      if (protectedRef(config, ref)) boundaries.push({ repo: at, operation, ref: refName(ref), candidate: sha(at, rev) });
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
        add(guarded.operation, guarded.ref, rev);
      }
    }
  }
  return boundaries;
}

function gate(boundary: Boundary, config: HookConfig, identity: Json): string | null {
  const args = ["pipeline", "gate", "--repo", boundary.repo, "--operation", boundary.operation, "--ref", boundary.ref, "--candidate", boundary.candidate];
  if (process.env.INBOX_PIPELINE_RUN) args.push("--run", process.env.INBOX_PIPELINE_RUN);
  if (process.env.INBOX_PIPELINE_ROUND) args.push("--round", process.env.INBOX_PIPELINE_ROUND);
  if (identity.harness && identity.session) args.push("--harness", identity.harness, "--session", identity.session);
  const [exe, ...prefix] = config.inboxCommand;
  const result = spawnSync(exe!, [...prefix, ...args], { cwd: boundary.repo, encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024 });
  if (result.status === 0 && !result.error) return null;
  if (result.status === 1) {
    const reason = result.stderr?.trim() || result.stdout?.trim() || "Protected delivery refused by the office pipeline gate.";
    return `${reason}\nIf the office is unavailable: Restart the office and retry; editing, tests and local commits remain available.`;
  }
  return `${OUTAGE}${result.stderr?.trim() ? `\n${result.stderr.trim()}` : ""}`;
}
export function guardTool(config: HookConfig, input: Json, cwd: string, harness: string, session = ""): string | null {
  const toolInput = input.tool_input ?? input.input ?? {};
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command !== "string" && !Array.isArray(command)) return null;
  try {
    for (const boundary of commandBoundaries(Array.isArray(command) ? command.map(quote).join(" ") : command, toolInput.cwd || toolInput.workdir || input.cwd || cwd, config)) {
      const reason = gate(boundary, config, { harness, session: session || input.session_id });
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
    const reason = gate({ repo: cwd, operation: "push", ref, candidate }, config, identity());
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
    commands.push({ command: "node .claude/hooks/worktree-sync.mjs land", operation: "land", ref: adapter.integrationBranch || "dev", candidateArgument: 1 });
    commands.push({ command: "node .claude/hooks/worktree-sync.mjs publish", operation: "publish", ref: adapter.integrationBranch || "dev" });
    // Accept a directly executable script as well as the usual node invocation.
    commands.push({ command: ".claude/hooks/worktree-sync.mjs land", operation: "land", ref: adapter.integrationBranch || "dev", candidateArgument: 1 });
    commands.push({ command: ".claude/hooks/worktree-sync.mjs publish", operation: "publish", ref: adapter.integrationBranch || "dev" });
  }
  return { marker: MARK, protectedRefs: refs, guardedCommands: commands, inboxCommand };
}
function mergeSettings(path: string, command: string, remove: boolean, original?: Manifest["settings"][string]): string | null {
  const settings = jsonFile(path);
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) throw new Error(`${path}: hooks must be an object`);
  const hooks = settings.hooks ?? {};
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse)) throw new Error(`${path}: PreToolUse must be an array`);
  const pre: Json[] = [];
  for (const group of hooks.PreToolUse ?? []) {
    if (!group || !Array.isArray(group.hooks)) throw new Error(`${path}: invalid PreToolUse hook group`);
    const remaining = group.hooks.filter((h: Json) => h.command !== command);
    if (remaining.length || !group.hooks.length) pre.push({ ...group, hooks: remaining });
  }
  if (!remove) pre.push({ matcher: ".*", hooks: [{ type: "command", command, timeout: 15 }] });
  if (pre.length || original?.pre) hooks.PreToolUse = pre; else delete hooks.PreToolUse;
  if (Object.keys(hooks).length || original?.hooks) settings.hooks = hooks; else delete settings.hooks;
  return remove && !original?.existed && !Object.keys(settings).length ? null : serialized(settings);
}

/** Validate a complete plan before touching disk. Existing unrelated settings are retained. */
export function installHooks(path: string, options: { dryRun?: boolean; uninstall?: boolean; inboxCommand?: string[] } = {}): Change[] {
  const repo = realpathSync(git(resolve(path), "rev-parse", "--show-toplevel")); rejectGlobal(repo);
  const local = join(repo, LOCAL); const manifestPath = join(local, "manifest.json");
  const prior = existsSync(manifestPath) ? jsonFile(manifestPath) as Manifest : undefined;
  if (prior && prior.marker !== MARK) throw new Error("Unrecognised hook manifest; refusing to overwrite");
  if (!prior && existsSync(local)) throw new Error(`${local} exists without our manifest; refusing to overwrite`);
  const runner = join(local, "pipeline-hooks.ts"); const configPath = join(local, "config.json");
  const settingsPaths = [join(repo, ".claude/settings.json"), join(repo, ".codex/hooks.json")];
  const pi = join(repo, ".pi/extensions/review-inbox-pipeline.ts");
  let prePush = prior?.prePush || resolve(repo, git(repo, "rev-parse", "--git-path", "hooks/pre-push"));
  prePush = resolve(prePush); rejectGlobal(prePush);
  // A hooksPath outside the checkout is explicit git configuration; honour it, but not symlinks.
  const common = realpathSync(resolve(repo, git(repo, "rev-parse", "--git-common-dir")));
  for (const p of [runner, manifestPath, configPath, ...settingsPaths, pi]) safePath(repo, p);
  if (existsSync(prePush) && lstatSync(prePush).isSymbolicLink()) throw new Error(`Refusing symlinked pre-push hook: ${prePush}`);
  const backup = prior?.backup || `${prePush}.review-inbox-original-${createHash("sha256").update(repo).digest("hex").slice(0, 12)}`;
  const commandFor = (mode: string) => `${quote(process.execPath)} ${quote(runner)} ${mode} ${quote(configPath)}`;
  const changes: Change[] = [];
  const settings: Manifest["settings"] = prior?.settings ?? {};
  for (const [i, p] of settingsPaths.entries()) {
    const s = jsonFile(p);
    settings[p] ??= { existed: existsSync(p), hooks: s.hooks !== undefined, pre: s.hooks?.PreToolUse !== undefined };
    if (!options.uninstall || existsSync(p)) changes.push({ path: p, content: mergeSettings(p, commandFor(i ? "codex" : "claude"), !!options.uninstall, settings[p]) });
  }
  const extension = `// ${MARK}\nimport { readFileSync } from 'node:fs';\nimport { guardTool } from ${JSON.stringify(runner)};\nexport default function (pi: any) {\n  pi.on('tool_call', (event: any, ctx: any) => {\n    const config = JSON.parse(readFileSync(${JSON.stringify(configPath)}, 'utf8'));\n    const reason = guardTool(config, event, ctx.cwd, 'pi', ctx.sessionManager.getSessionFile() || '');\n    if (reason) return { block: true, reason };\n  });\n}\n`;
  if (existsSync(pi) && !readFileSync(pi, "utf8").startsWith(`// ${MARK}\n`)) throw new Error(`Refusing to replace another Pi extension: ${pi}`);
  const originalExecutable = existsSync(backup) ? !!(statSync(backup).mode & 0o111) : !prior && existsSync(prePush) && !!(statSync(prePush).mode & 0o111);
  const wrapper = `#!/bin/sh\n# ${MARK}\ninput=$(mktemp) || exit 1\ntrap 'rm -f "$input"' EXIT HUP INT TERM\ncat > "$input"\n${commandFor("pre-push")} < "$input" || exit $?\n${originalExecutable ? `${quote(backup)} "$@" < "$input"\nexit $?` : "exit 0"}\n`;
  const current = existsSync(prePush) ? readFileSync(prePush, "utf8") : "";
  if (prior && current !== prior.wrapper) throw new Error(`Pre-push changed since installation; keep it and resolve manually: ${prePush}`);
  if (!prior && existsSync(backup)) throw new Error(`A pipeline backup already owns ${backup}; resolve it before installing`);
  if (options.uninstall) {
    if (!prior) return [];
    changes.push({ path: pi, content: null });
    changes.push(existsSync(backup) ? { path: prePush, content: null, renameFrom: backup } : { path: prePush, content: null });
    for (const p of [runner, configPath, manifestPath]) changes.push({ path: p, content: null });
  } else {
    const config = configured(repo, options.inboxCommand ?? [process.execPath, fileURLToPath(new URL("../../bin/inbox", import.meta.url))]);
    // Re-install may add protection, never silently remove an already installed boundary.
    if (prior) {
      const previous = jsonFile(configPath) as HookConfig;
      config.protectedRefs = [...new Set([...previous.protectedRefs, ...config.protectedRefs])];
      config.guardedCommands = [...new Map([...previous.guardedCommands, ...config.guardedCommands].map((c) => [JSON.stringify(c), c])).values()];
    }
    changes.push({ path: runner, content: readFileSync(fileURLToPath(import.meta.url), "utf8") });
    changes.push({ path: configPath, content: serialized(config) }, { path: pi, content: extension });
    if (!prior && existsSync(prePush)) changes.push({ path: backup, content: null, renameFrom: prePush });
    changes.push({ path: prePush, content: wrapper, mode: 0o755 });
    changes.push({ path: manifestPath, content: serialized({ marker: MARK, prePush, backup, wrapper, settings } satisfies Manifest) });
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
  const changes = installHooks(parsed.positionals[0]!, { dryRun: parsed.values["dry-run"], uninstall: parsed.values.uninstall });
  for (const change of changes) console.log(`${parsed.values["dry-run"] ? "Would " : ""}${change.renameFrom ? "restore/chain" : change.content === null ? "remove" : "write"} ${change.path}`);
  if (!parsed.values.uninstall) console.log("Trust/reload project hooks in each harness before delivery. Preflight is not delivery evidence; protected pre-push rechecks every ref.");
}

function hookMain(): void {
  const [mode, configPath] = process.argv.slice(2);
  if (!configPath) throw new Error(OUTAGE);
  const config = jsonFile(configPath) as HookConfig;
  if (config.marker !== MARK || !Array.isArray(config.protectedRefs) || !config.inboxCommand?.length) throw new Error(OUTAGE);
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
