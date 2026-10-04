// The installer's committed output names no machine or checkout path; this machine's node, runner,
// config and inbox command live in the main checkout's ignored .review-inbox-pipeline/, which every
// worktree finds through the Git common dir. All repos and HOMEs here are temporary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HARNESS_COMMANDS, installHooks } from "../src/cli/pipeline-hooks.ts";

// Installs run in-process: give this process a temporary HOME, so nothing can reach the real harness settings.
const REAL_HOME = homedir();
process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-paths-home-")));
process.on("exit", () => rmSync(process.env.HOME!, { recursive: true, force: true }));
delete process.env.CLAUDE_PROJECT_DIR;
const OFFICE = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const TRACKED = [".claude/settings.json", ".codex/hooks.json", ".claude/hooks/review-inbox-pipeline.mjs", ".claude/hooks/review-inbox-pipeline.sh", ".pi/extensions/review-inbox-pipeline.ts"];

function scratch(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-paths-"))); const repo = join(root, "main space"); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Scratch", GIT_AUTHOR_EMAIL: "scratch@invalid", GIT_COMMITTER_NAME: "Scratch", GIT_COMMITTER_EMAIL: "scratch@invalid" };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(repo, "init", "-b", "dev"); writeFileSync(join(repo, "file"), "one"); git(repo, "add", "file"); git(repo, "commit", "-m", "seed");
  const calls = join(root, "calls.jsonl"); const gate = join(root, "fake-inbox.mjs");
  writeFileSync(gate, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(Number(process.env.SCRATCH_GATE_EXIT || 0));`);
  const inboxCommand = [process.execPath, gate];
  const install = (options: Parameters<typeof installHooks>[1] = {}) => installHooks(repo, { inboxCommand, ...options });
  const gateCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  /** Run a committed harness command the way the harness does: through a shell, in `cwd`, with only `extra` beyond PATH/HOME. */
  const harness = (mode: "claude" | "codex", cwd: string, command: string, extra: Record<string, string> = {}) => {
    const settings = JSON.parse(readFileSync(join(cwd, mode === "claude" ? ".claude/settings.json" : ".codex/hooks.json"), "utf8"));
    const hook = settings.hooks.PreToolUse.flatMap((g: any) => g.hooks).find((h: any) => h.command === HARNESS_COMMANDS[mode]);
    assert.ok(hook, `${mode} runs the committed launcher`);
    const r = spawnSync("/bin/sh", ["-c", hook.command], { cwd, env: { ...env, ...extra }, input: JSON.stringify({ session_id: "scratch", tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const denial = (output: any) => output.hookSpecificOutput?.permissionDecision === "deny" ? output.hookSpecificOutput.permissionDecisionReason as string : null;
  const changed = () => changedIn(git, repo);
  return { root, repo, env, git, changed, install, inboxCommand, gateCalls, harness, denial };
}
/** Every path that differs from HEAD, committed or not (stages them). */
function changedIn(git: (cwd: string, ...args: string[]) => string, repo: string): string[] {
  git(repo, "add", "-A"); return git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
}
async function piHandler(checkout: string) {
  const extension = await import(`${join(checkout, ".pi/extensions/review-inbox-pipeline.ts")}?${Math.random()}`);
  let handler: any; extension.default({ on(_: string, callback: any) { handler = callback; } });
  return (command: string) => handler({ input: { command } }, { cwd: checkout, sessionManager: { getSessionFile: () => undefined } });
}

test("committed output names no home, Cellar, node, office or checkout path; the local install holds them and ignores itself", (t) => {
  const s = scratch(t);
  // A FysikLab-shaped adapter, with a declared lane whose checkout is an absolute path on this machine.
  const lane = join(s.root, "einstein"); s.git(s.repo, "worktree", "add", "-b", "einstein", lane);
  writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ project: "fysiklab", integrationBranch: "dev", lanes: [{ name: "einstein", worktree: "../einstein" }], pipelineHooks: { laneDelivery: { lanes: ["einstein"] } } }));
  s.install({ node: "/opt/homebrew/Cellar/node@24/24.21.0/bin/node" });
  const forbidden = [s.root, s.repo, lane, REAL_HOME, homedir(), OFFICE, process.execPath, "/opt/homebrew", "Cellar", "/Users/", "/home/", "/private/", "/var/folders"];
  for (const file of TRACKED) {
    const text = readFileSync(join(s.repo, file), "utf8");
    for (const path of forbidden) assert.ok(!text.includes(path), `${file} names ${path}`);
  }
  const local = join(s.repo, ".review-inbox-pipeline");
  assert.equal(readFileSync(join(local, "node"), "utf8"), "/opt/homebrew/Cellar/node@24/24.21.0/bin/node\n");
  const config = JSON.parse(readFileSync(join(local, "config.json"), "utf8"));
  assert.deepEqual(config.inboxCommand, s.inboxCommand); assert.deepEqual(config.lanes, [{ name: "einstein", checkout: realpathSync(lane) }]);
  // Exactly the committed files show up for Git; the local directory needs no entry in the project's .gitignore.
  assert.deepEqual(s.changed(), [...TRACKED, "orchestrator.json"].sort());
});

test("from a lane worktree every harness and Git find the main checkout's runner and config through the Git common dir", async (t) => {
  const s = scratch(t); s.install();
  s.git(s.repo, "add", "-A"); s.git(s.repo, "commit", "-m", "Install pipeline hooks");
  const lane = join(s.root, "lane"); s.git(s.repo, "worktree", "add", "-b", "lane", lane);
  assert.equal(existsSync(join(lane, ".review-inbox-pipeline")), false, "ignored files never reach a worktree");
  const askedFrom = () => { const call = s.gateCalls().at(-1)!; return call[call.indexOf("--repo") + 1]!; };
  // Claude names the project; Codex has only its cwd. Either way the gate (in the main checkout's config) is asked.
  for (const [mode, extra] of [["claude", { CLAUDE_PROJECT_DIR: lane }], ["claude", {}], ["codex", {}]] as const) {
    const before = s.gateCalls().length;
    assert.deepEqual(s.harness(mode, lane, "git push origin HEAD:dev", extra), {});
    assert.equal(s.gateCalls().length, before + 1, `${mode} asked the gate`); assert.equal(realpathSync(askedFrom()), realpathSync(lane));
    assert.deepEqual(s.harness(mode, lane, "git push origin HEAD:feature", extra), {});
    assert.equal(s.gateCalls().length, before + 1, "an ordinary push asks nobody");
  }
  const pi = await piHandler(lane); const before = s.gateCalls().length;
  assert.equal(await pi("git push origin HEAD:dev"), undefined); assert.equal(s.gateCalls().length, before + 1);
  // Git's shared pre-push, run for the worktree's push.
  const remote = join(s.root, "remote.git"); s.git(s.root, "init", "--bare", remote); s.git(lane, "remote", "add", "origin", remote);
  const push = spawnSync("git", ["-C", lane, "push", "origin", "HEAD:dev"], { encoding: "utf8", env: s.env });
  assert.equal(push.status, 0, push.stderr); assert.equal(s.gateCalls().length, before + 2);
  // A refusal from the office reaches the worktree's harness.
  const refused = s.harness("codex", lane, "git push origin HEAD:dev", { SCRATCH_GATE_EXIT: "1" });
  assert.ok(s.denial(refused));
});

test("a missing runner, config or node fails closed with how to reinstall; editing, tests and local commits stay available", async (t) => {
  const s = scratch(t); s.install();
  s.git(s.repo, "add", "-A"); s.git(s.repo, "commit", "-m", "Install pipeline hooks");
  const lane = join(s.root, "lane"); s.git(s.repo, "worktree", "add", "-b", "lane", lane);
  const local = join(s.repo, ".review-inbox-pipeline"); const runner = readFileSync(join(local, "pipeline-hooks.ts"), "utf8");
  const ordinary = ["npm test && git commit -m local", "git push origin HEAD:feature"];
  const check = async (failure: string, reason: RegExp, extra: Record<string, string> = {}, modes: ("claude" | "codex" | "pi")[] = ["claude", "codex", "pi"], allowed = ordinary) => {
    for (const mode of modes) {
      const invoke = mode === "pi" ? await piHandler(lane).then((pi) => async (c: string) => { const r = await pi(c); return r ? { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: r.reason } } : {}; }) : async (c: string) => s.harness(mode, lane, c, extra);
      const denied = s.denial(await invoke("git push origin HEAD:dev"));
      assert.ok(denied, `${failure}: ${mode} denies delivery`); assert.match(denied!, reason); assert.match(denied!, /reinstall pipeline hooks from the Review Inbox checkout: bin\/inbox pipeline install-hooks/);
      for (const command of allowed) assert.deepEqual(await invoke(command), {}, `${failure}: ${mode} allows ${command}`);
    }
  };
  rmSync(join(local, "pipeline-hooks.ts"));
  await check("runner missing", /runner missing at .*main space\/\.review-inbox-pipeline\/pipeline-hooks\.ts/);
  writeFileSync(join(local, "pipeline-hooks.ts"), runner); rmSync(join(local, "config.json"));
  await check("config missing", /runner missing at/);
  // No node anywhere: neither the recorded one nor PATH. The launcher itself denies without starting node.
  s.install(); writeFileSync(join(local, "node"), "/nonexistent/node\n");
  const noNode = "/usr/bin:/bin";
  if (spawnSync("/bin/sh", ["-c", "command -v node"], { env: { PATH: noNode } }).status === 0) { t.diagnostic("node is on /usr/bin:/bin; skipping the node-missing case"); return; }
  // Without node the launcher cannot tell refs apart, so it refuses every push, not only protected ones.
  await check("node missing", /no node found for the pipeline guard/, { PATH: noNode }, ["claude", "codex"], ["npm test && git commit -m local"]);
  assert.ok(s.denial(s.harness("codex", lane, "git push origin HEAD:feature", { PATH: noNode })));
  assert.deepEqual(s.harness("claude", lane, "ls", { PATH: noNode }), {});
  // An edit whose text mentions delivery is not a shell command, so it is never refused.
  const edit = spawnSync("/bin/sh", ["-c", HARNESS_COMMANDS.claude], { cwd: lane, env: { ...s.env, PATH: noNode }, input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "notes", content: '{"command": "git push origin HEAD:dev"}' } }), encoding: "utf8" });
  assert.deepEqual(JSON.parse(edit.stdout), {});
  const remote = join(s.root, "remote.git"); s.git(s.root, "init", "--bare", remote); s.git(lane, "remote", "add", "origin", remote);
  const push = spawnSync("/usr/bin/git", ["-C", lane, "push", "origin", "HEAD:dev"], { encoding: "utf8", env: { ...s.env, PATH: noNode } });
  assert.notEqual(push.status, 0); assert.match(push.stderr, /no node found for the pipeline guard/);
  // The recorded node is used even when PATH has none.
  writeFileSync(join(local, "node"), `${process.execPath}\n`);
  assert.deepEqual(s.harness("codex", lane, "git push origin HEAD:dev", { PATH: noNode }), {});
});

test("install, uninstall and reinstall round-trip byte for byte, keeping the project's own hooks and settings", (t) => {
  const s = scratch(t);
  mkdirSync(join(s.repo, ".claude")); mkdirSync(join(s.repo, ".codex"));
  const own = JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/native-lane.mjs"' }] }] } }, null, 2) + "\n";
  writeFileSync(join(s.repo, ".claude/settings.json"), own);
  const hook = join(s.repo, ".git/hooks/pre-push"); writeFileSync(hook, "#!/bin/sh\nexit 0\n"); chmodSync(hook, 0o755);
  s.git(s.repo, "add", "-A"); s.git(s.repo, "commit", "-m", "Project settings");
  const snapshot = () => Object.fromEntries([...TRACKED, ".git/hooks/pre-push", ".review-inbox-pipeline/config.json", ".review-inbox-pipeline/node"].map((f) => [f, existsSync(join(s.repo, f)) ? readFileSync(join(s.repo, f), "utf8") : null]));
  const before = snapshot();
  s.install(); const installed = snapshot();
  assert.ok(installed[".claude/hooks/review-inbox-pipeline.sh"]);
  s.install({ uninstall: true });
  assert.deepEqual(snapshot(), before); assert.equal(existsSync(join(s.repo, ".review-inbox-pipeline")), false);
  assert.equal(s.git(s.repo, "status", "--porcelain", "--untracked-files=all"), "", "uninstall leaves the checkout as committed");
  s.install(); assert.deepEqual(snapshot(), installed);
  s.install(); assert.deepEqual(snapshot(), installed, "reinstall is idempotent");
});

test("upgrading FysikLab's v1 install drops every absolute path, keeps its boundaries, and old worktree files keep working", async (t) => {
  const s = scratch(t); const local = join(s.repo, ".review-inbox-pipeline"); const old = "/opt/homebrew/Cellar/node@24/24.21.0/bin/node";
  // Today's FysikLab: v1 manifest and harness commands calling the runner by absolute path, the hand-patched
  // v2-marked Pi extension, a v1 pre-push wrapper, and its own hooks beside ours.
  s.install(); rmSync(join(s.repo, ".claude/hooks/review-inbox-pipeline.sh")); rmSync(join(s.repo, ".claude/hooks/review-inbox-pipeline.mjs"));
  const runner = join(local, "pipeline-hooks.ts"); const configPath = join(local, "config.json");
  const v1 = (mode: string) => `'${old}' '${runner}' ${mode} '${configPath}'`;
  const wrapper = `#!/bin/sh\n# review-inbox-pipeline-guard-v1\ninput=$(mktemp) || exit 1\ntrap 'rm -f "$input"' EXIT HUP INT TERM\ncat > "$input"\n'${old}' '${runner}' pre-push '${configPath}' < "$input" || exit $?\nexit 0\n`;
  const manifest = JSON.parse(readFileSync(join(local, "manifest.json"), "utf8"));
  writeFileSync(join(local, "manifest.json"), JSON.stringify({ marker: "review-inbox-pipeline-guard-v1", prePush: manifest.prePush, backup: manifest.backup, wrapper, settings: manifest.settings }));
  writeFileSync(manifest.prePush, wrapper); chmodSync(manifest.prePush, 0o755);
  const config = JSON.parse(readFileSync(configPath, "utf8")); delete config._generated; config.marker = "review-inbox-pipeline-guard-v1"; config.protectedRefs.push("refs/heads/release");
  writeFileSync(configPath, JSON.stringify(config)); rmSync(join(local, "node")); rmSync(join(local, ".gitignore"));
  writeFileSync(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"), `// review-inbox-pipeline-guard-v2\nconst RUNNER_PATH = ${JSON.stringify(runner)};\n`);
  for (const [file, mode] of [[".claude/settings.json", "claude"], [".codex/hooks.json", "codex"]] as const) {
    writeFileSync(join(s.repo, file), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/native-lane.mjs"' }] }, { matcher: ".*", hooks: [{ type: "command", command: v1(mode), timeout: 15 }] }] } }));
  }
  writeFileSync(join(s.repo, ".gitignore"), "/.review-inbox-pipeline/\n");
  s.git(s.repo, "add", "-A"); s.git(s.repo, "commit", "-m", "FysikLab v1 install");
  const oldLane = join(s.root, "old-lane"); s.git(s.repo, "worktree", "add", "-b", "old-lane", oldLane);

  const dry = s.install({ dryRun: true });
  assert.equal(readFileSync(join(s.repo, ".claude/settings.json"), "utf8").includes(old), true, "a dry run writes nothing");
  assert.deepEqual(s.install().map((c) => c.path), dry.map((c) => c.path));
  for (const file of TRACKED) for (const path of [old, s.repo, s.root, OFFICE]) assert.ok(!readFileSync(join(s.repo, file), "utf8").includes(path), `${file} names ${path}`);
  for (const [file, mode] of [[".claude/settings.json", "claude"], [".codex/hooks.json", "codex"]] as const) {
    const commands = JSON.parse(readFileSync(join(s.repo, file), "utf8")).hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.deepEqual(commands, ['node "$CLAUDE_PROJECT_DIR/.claude/hooks/native-lane.mjs"', HARNESS_COMMANDS[mode]]);
  }
  assert.ok(JSON.parse(readFileSync(configPath, "utf8")).protectedRefs.includes("refs/heads/release"), "boundaries are kept");
  assert.equal(JSON.parse(readFileSync(join(local, "manifest.json"), "utf8")).marker, "review-inbox-pipeline-guard-v2");
  assert.equal(existsSync(manifest.backup), false, "no original pre-push was invented");
  // The changed tracked files are exactly these.
  assert.deepEqual(s.changed(), [...TRACKED].sort());
  // A lane still on the old commit carries the v1 command; it reaches the upgraded runner and config.
  const before = s.gateCalls().length;
  const r = spawnSync("/bin/sh", ["-c", v1("claude").replace(old, process.execPath)], { cwd: oldLane, env: s.env, input: JSON.stringify({ tool_input: { command: "git push origin HEAD:release" } }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {}); assert.equal(s.gateCalls().length, before + 1);
  // Uninstall from here is clean too.
  s.install({ uninstall: true });
  for (const file of [".claude/hooks/review-inbox-pipeline.sh", ".claude/hooks/review-inbox-pipeline.mjs", ".pi/extensions/review-inbox-pipeline.ts"]) assert.equal(existsSync(join(s.repo, file)), false);
  assert.equal(existsSync(manifest.prePush), false); assert.equal(existsSync(local), false);
  assert.equal(dirname(manifest.prePush), join(realpathSync(s.repo), ".git/hooks"));
});

/** The committed command run through sh, as a harness would: any cwd, only `extra` beyond PATH/HOME, a Bash tool payload. */
function runCommand(mode: "claude" | "codex", cwd: string, env: Record<string, string>, command: string, tool = "Bash") {
  return spawnSync("/bin/sh", ["-c", HARNESS_COMMANDS[mode]], { cwd, env, input: JSON.stringify({ session_id: "scratch", tool_name: tool, tool_input: { command } }), encoding: "utf8" });
}

test("outside any work tree the committed commands deny delivery and let ordinary commands through, never exiting 127", (t) => {
  const s = scratch(t); s.install();
  s.git(s.repo, "add", "-A"); s.git(s.repo, "commit", "-m", "Install pipeline hooks");
  const outside = join(s.root, "not a repo"); mkdirSync(outside);
  assert.notEqual(spawnSync("git", ["-C", outside, "rev-parse", "--show-toplevel"], { env: { ...s.env, GIT_CEILING_DIRECTORIES: s.root } }).status, 0, "the scratch cwd is outside every work tree");
  const env = { ...s.env, GIT_CEILING_DIRECTORIES: s.root };
  const land = `node .claude/hooks/worktree-sync.mjs land ${s.repo} abc123`;
  for (const mode of ["claude", "codex"] as const) {
    for (const command of [`git -C ${s.repo} push origin dev`, land, "git push origin HEAD:dev", "gh pr merge 7", "npm publish"]) {
      const r = runCommand(mode, outside, env, command);
      assert.equal(r.status, 0, `${mode} ${command}: ${r.stderr}`); assert.match(s.denial(JSON.parse(r.stdout)) ?? "", /Protected delivery blocked/, `${mode} denies ${command}`);
    }
    for (const command of ["ls", "npm test && git commit -m local", "cat notes.md"]) {
      const r = runCommand(mode, outside, env, command);
      assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {}, `${mode} allows ${command}`);
    }
    // Text that mentions delivery but is not a shell command (an edit) is not refused.
    const edit = spawnSync("/bin/sh", ["-c", HARNESS_COMMANDS[mode]], { cwd: outside, env, input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "notes", content: "git push origin dev" } }), encoding: "utf8" });
    assert.deepEqual(JSON.parse(edit.stdout), {});
  }
});

test("a missing launcher inside a repository denies delivery instead of exiting 127", (t) => {
  const s = scratch(t); s.install();
  s.git(s.repo, "add", "-A"); s.git(s.repo, "commit", "-m", "Install pipeline hooks");
  rmSync(join(s.repo, ".claude/hooks/review-inbox-pipeline.sh"));
  for (const mode of ["claude", "codex"] as const) {
    const denied = runCommand(mode, s.repo, s.env, "git push origin dev");
    assert.equal(denied.status, 0, denied.stderr); assert.ok(s.denial(JSON.parse(denied.stdout)), `${mode} denies delivery`);
    assert.deepEqual(JSON.parse(runCommand(mode, s.repo, s.env, "ls").stdout), {}, `${mode} allows ls`);
  }
});

test("reinstall replaces the earlier commands that failed open and adds no duplicate", (t) => {
  const s = scratch(t);
  const earlier: Record<string, string> = { ".claude/settings.json": 'sh "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/hooks/review-inbox-pipeline.sh" claude', ".codex/hooks.json": 'sh "$(git rev-parse --show-toplevel)/.claude/hooks/review-inbox-pipeline.sh" codex' };
  for (const [file, command] of Object.entries(earlier)) {
    mkdirSync(dirname(join(s.repo, file)), { recursive: true });
    writeFileSync(join(s.repo, file), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command, timeout: 15 }] }] } }));
  }
  s.install();
  for (const [file, mode] of [[".claude/settings.json", "claude"], [".codex/hooks.json", "codex"]] as const) {
    const commands = JSON.parse(readFileSync(join(s.repo, file), "utf8")).hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.deepEqual(commands, [HARNESS_COMMANDS[mode]]);
  }
});
