import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, statSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer as reservePort } from "node:net";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { createInboxServer } from "../src/server/http.ts";
import { commandBoundaries, guardPrePush, guardTool, HARNESS_COMMANDS, installHooks, stableNode, type HookConfig } from "../src/cli/pipeline-hooks.ts";

// Harness commands are run here with this process's environment; a surrounding Claude session's project is not theirs.
delete process.env.CLAUDE_PROJECT_DIR;

function scratch(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "pipeline-hooks-")); const repo = join(root, "repo space"); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git("init", "-b", "feature"); git("config", "user.name", "Scratch"); git("config", "user.email", "scratch@invalid");
  writeFileSync(join(repo, "file"), "one"); git("add", "file"); git("commit", "-m", "seed");
  git("branch", "dev"); git("branch", "main");
  const candidate = git("rev-parse", "HEAD");
  const calls = join(root, "calls.jsonl"); const gate = join(root, "fake-gate.mjs");
  writeFileSync(gate, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(Number(process.env.SCRATCH_GATE_EXIT || 0));`);
  const config: HookConfig = { marker: "review-inbox-pipeline-guard-v1", protectedRefs: ["refs/heads/dev", "refs/heads/main"], guardedCommands: [], inboxCommand: [process.execPath, gate] };
  const install = (options = {}) => installHooks(repo, { inboxCommand: config.inboxCommand, ...options });
  const readCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((s) => JSON.parse(s) as string[]) : [];
  return { root, repo, git, candidate, config, install, calls, readCalls };
}

test("install merges both harness settings, preserves hooks and other keys, is byte-idempotent", (t) => {
  const s = scratch(t);
  for (const [dir, file] of [[".claude", "settings.json"], [".codex", "hooks.json"]]) {
    mkdirSync(join(s.repo, dir!));
    writeFileSync(join(s.repo, dir!, file!), JSON.stringify({ keep: { nested: 7 }, hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-stop" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-pre" }] }] } }));
  }
  s.install();
  const before = readFileSync(join(s.repo, ".claude/settings.json"), "utf8");
  s.install();
  assert.equal(readFileSync(join(s.repo, ".claude/settings.json"), "utf8"), before);
  const settings = JSON.parse(before);
  assert.deepEqual(settings.keep, { nested: 7 }); assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "keep-stop");
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "keep-pre");
  const r = spawnSync(join(s.repo, ".git/hooks/pre-push"), ["origin", "scratch"], { cwd: s.repo, input: "", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); // No phantom original hook on re-install.
});

test("the installed runner starts without Node's MODULE_TYPELESS_PACKAGE_JSON warning; its package.json is part of the install, uninstall and reinstall", (t) => {
  const s = scratch(t); const local = join(s.repo, ".review-inbox-pipeline"); const marker = join(local, "package.json");
  // As in a real project: a package.json without "type" above the runner is what makes Node warn about it.
  writeFileSync(join(s.repo, "package.json"), '{"name":"scratch-project"}\n'); s.git("add", "package.json"); s.git("commit", "-m", "package.json");
  const plan = s.install({ dryRun: true });
  assert.equal(plan.length, 12, "the dry run lists twelve writes"); assert.ok(plan.some((c) => c.path.endsWith("/.review-inbox-pipeline/package.json") && c.content === '{"type":"module"}\n'));
  assert.equal(existsSync(local), false, "a dry run writes nothing");
  s.install();
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { type: "module" });
  const run = () => spawnSync(process.execPath, [join(local, "pipeline-hooks.ts"), "claude", join(local, "config.json")], { cwd: s.repo, env: { ...process.env, HOME: s.root }, input: JSON.stringify({ tool_input: { command: "ls" } }), encoding: "utf8" });
  let r = run(); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {});
  assert.doesNotMatch(r.stderr, /MODULE_TYPELESS_PACKAGE_JSON/); assert.equal(r.stderr, "");
  // The check can fail: the same runner without the file does warn.
  rmSync(marker); r = run(); assert.match(r.stderr, /MODULE_TYPELESS_PACKAGE_JSON/);
  // Reinstall restores it without a manifest edit; the directory still ignores itself, so Git never sees it.
  s.install(); assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { type: "module" });
  assert.equal(run().stderr, ""); assert.ok(!s.git("status", "--short", "--ignored").split("\n").some((l) => l.startsWith("??") && l.includes(".review-inbox-pipeline")));
  // Uninstall removes it, so the directory goes too; installing again brings it back.
  s.install({ uninstall: true }); assert.equal(existsSync(marker), false); assert.equal(existsSync(local), false);
  s.install(); assert.ok(existsSync(marker)); assert.equal(run().stderr, "");
});

test("dry-run has no writes; uninstall removes only our hook and retains concurrent additions", (t) => {
  const s = scratch(t); const plan = s.install({ dryRun: true }); assert.ok(plan.length); assert.equal(existsSync(join(s.repo, ".claude")), false);
  s.install();
  const path = join(s.repo, ".claude/settings.json"); const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.permissions = { allow: ["Read"] };
  settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "new-hook" });
  writeFileSync(path, JSON.stringify(settings));
  s.install({ uninstall: true });
  const after = JSON.parse(readFileSync(path, "utf8")); assert.deepEqual(after.permissions, settings.permissions);
  assert.equal(after.hooks.PreToolUse[0].hooks.length, 1); assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "new-hook");
  assert.equal(existsSync(join(s.repo, ".codex/hooks.json")), false);
  assert.equal(existsSync(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts")), false);
  s.install({ uninstall: true }); s.install(); // Uninstall itself is idempotent, and re-install works.
});

test("malformed settings and symlinked project dirs refuse before any write", (t) => {
  const s = scratch(t); mkdirSync(join(s.repo, ".codex")); writeFileSync(join(s.repo, ".codex/hooks.json"), '{"hooks":{"PreToolUse":{}}}');
  assert.throws(() => s.install(), /PreToolUse/); assert.equal(existsSync(join(s.repo, ".claude")), false);
  rmSync(join(s.repo, ".codex"), { recursive: true });
  const outside = join(s.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(s.repo, ".claude"));
  assert.throws(() => s.install(), /symlink/); assert.equal(existsSync(join(outside, "settings.json")), false);
});

test("respects core.hooksPath, chains original stdin/argv/status, restores bytes and executable mode", (t) => {
  const s = scratch(t); s.git("config", "core.hooksPath", "custom-hooks"); mkdirSync(join(s.repo, "custom-hooks"));
  const hook = join(s.repo, "custom-hooks/pre-push"); const output = join(s.root, "original-input");
  const original = `#!/bin/sh\nprintf '%s %s\\n' "$1" "$2" > '${output}'\ncat >> '${output}'\nexit 7\n`;
  writeFileSync(hook, original); chmodSync(hook, 0o751); s.install(); s.install();
  const input = `refs/heads/feature ${s.candidate} refs/heads/dev ${s.candidate}\n`;
  const r = spawnSync(hook, ["origin", "url"], { cwd: s.repo, input, encoding: "utf8" });
  assert.equal(r.status, 7, r.stderr); assert.equal(readFileSync(output, "utf8"), "origin url\n" + input);
  assert.equal(s.readCalls().length, 1);
  s.install({ uninstall: true }); assert.equal(readFileSync(hook, "utf8"), original); assert.equal(statSync(hook).mode & 0o777, 0o751);
});

test("modified existing pre-push is never overwritten or removed on uninstall", (t) => {
  const s = scratch(t); s.install(); const hook = join(s.repo, ".git/hooks/pre-push"); writeFileSync(hook, "new owner's hook");
  assert.throws(() => s.install({ uninstall: true }), /changed since/); assert.equal(readFileSync(hook, "utf8"), "new owner's hook");
});

test("pre-push checks every protected ref at its included SHA, permits ordinary refs during outage", (t) => {
  const s = scratch(t);
  assert.equal(guardPrePush(s.config, `x ${s.candidate} refs/heads/feature ${s.candidate}\nx ${s.candidate} refs/heads/dev ${s.candidate}\nx ${s.candidate} refs/heads/main ${s.candidate}\n`, s.repo), null);
  const calls = s.readCalls(); assert.equal(calls.length, 2); assert.equal(calls[0]![calls[0]!.indexOf("--candidate") + 1], s.candidate);
  const down = { ...s.config, inboxCommand: ["/nonexistent/inbox"] };
  assert.match(guardPrePush(down, `x ${s.candidate} refs/heads/dev ${s.candidate}`, s.repo)!, /Restart the office and retry/);
  assert.equal(guardPrePush(down, `x ${s.candidate} refs/heads/feature ${s.candidate}`, s.repo), null);
  assert.match(guardPrePush(s.config, `x ${"0".repeat(40)} refs/heads/main ${s.candidate}`, s.repo)!, /deleting/);
});

test("gate argv binds run, round, session, repo, ref and candidate; exit 1 also has restart guidance", (t) => {
  const s = scratch(t);
  const names = ["INBOX_PIPELINE_RUN", "INBOX_PIPELINE_ROUND", "SCRATCH_GATE_EXIT"];
  const before = names.map((n) => process.env[n]);
  t.after(() => names.forEach((n, i) => { if (before[i] === undefined) delete process.env[n]; else process.env[n] = before[i]; }));
  process.env.INBOX_PIPELINE_RUN = "scratch-run"; process.env.INBOX_PIPELINE_ROUND = "3"; process.env.SCRATCH_GATE_EXIT = "1";
  const reason = guardTool(s.config, { input: { command: "git push origin HEAD:dev" } }, s.repo, "pi", "/scratch/session.jsonl");
  assert.match(reason!, /Restart the office and retry/);
  const args = s.readCalls()[0]!;
  const value = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(value("--run"), "scratch-run"); assert.equal(value("--round"), "3");
  assert.equal(value("--repo"), s.repo); assert.equal(value("--candidate"), s.candidate);
  assert.equal(value("--operation"), "push"); assert.equal(value("--ref"), "refs/heads/dev");
  assert.equal(value("--harness"), "pi"); assert.equal(value("--session"), "/scratch/session.jsonl");
});

test("the guarded command names its own run: inline and env-prefixed, process env only as fallback", (t) => {
  const s = scratch(t);
  const names = ["INBOX_PIPELINE_RUN", "INBOX_PIPELINE_ROUND", "SCRATCH_GATE_EXIT"];
  const before = names.map((n) => process.env[n]);
  t.after(() => names.forEach((n, i) => { if (before[i] === undefined) delete process.env[n]; else process.env[n] = before[i]; }));
  names.forEach((n) => delete process.env[n]);
  const gated = (command: string) => {
    const before = s.readCalls().length; const reason = guardTool(s.config, { tool_input: { command } }, s.repo, "claude", "scratch-session");
    return { reason, calls: s.readCalls().slice(before) };
  };
  const value = (args: string[], name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const land = `node .claude/hooks/worktree-sync.mjs land '${s.repo}' ${s.candidate}`;
  const landing = { ...s.config, guardedCommands: [{ command: "node .claude/hooks/worktree-sync.mjs land", operation: "land" as const, ref: "dev", candidateArgument: 1 }] };
  const landGate = (command: string) => {
    const before = s.readCalls().length; const reason = guardTool(landing, { tool_input: { command } }, s.repo, "claude", "scratch-session");
    return { reason, calls: s.readCalls().slice(before) };
  };

  // Inline assignment on the land command reaches the gate; so does one after `env`, with its round.
  let r = landGate(`INBOX_PIPELINE_RUN=5cc68709 ${land}`);
  assert.equal(r.reason, null); assert.equal(r.calls.length, 1);
  assert.equal(value(r.calls[0]!, "--run"), "5cc68709"); assert.equal(value(r.calls[0]!, "--round"), undefined);
  assert.equal(value(r.calls[0]!, "--operation"), "land");
  r = landGate(`env INBOX_PIPELINE_RUN="5cc68709" INBOX_PIPELINE_ROUND=4 ${land}`);
  assert.equal(value(r.calls[0]!, "--run"), "5cc68709"); assert.equal(value(r.calls[0]!, "--round"), "4");
  r = gated("INBOX_PIPELINE_RUN=abc git push origin HEAD:dev");
  assert.equal(value(r.calls[0]!, "--run"), "abc");

  // Process env remains the fallback; the command's own run wins and does not borrow another run's round.
  process.env.INBOX_PIPELINE_RUN = "from-env"; process.env.INBOX_PIPELINE_ROUND = "7";
  r = gated("git push origin HEAD:dev");
  assert.equal(value(r.calls[0]!, "--run"), "from-env"); assert.equal(value(r.calls[0]!, "--round"), "7");
  r = gated("INBOX_PIPELINE_RUN=inline git push origin HEAD:dev");
  assert.equal(value(r.calls[0]!, "--run"), "inline"); assert.equal(value(r.calls[0]!, "--round"), undefined);
  r = gated("INBOX_PIPELINE_RUN=from-env git push origin HEAD:dev");
  assert.equal(value(r.calls[0]!, "--round"), "7");
  delete process.env.INBOX_PIPELINE_RUN; delete process.env.INBOX_PIPELINE_ROUND;

  // A run named on one segment never applies to another segment of a compound command.
  r = gated("INBOX_PIPELINE_RUN=first git push origin HEAD:dev && git push origin HEAD:main; INBOX_PIPELINE_RUN=third git push origin HEAD:dev");
  assert.deepEqual(r.calls.map((c) => value(c, "--run")), ["first", undefined, "third"]);
  assert.deepEqual(r.calls.map((c) => value(c, "--ref")), ["refs/heads/dev", "refs/heads/main", "refs/heads/dev"]);
  r = gated("export INBOX_PIPELINE_RUN=exported; git push origin HEAD:dev");
  assert.equal(value(r.calls[0]!, "--run"), undefined, "a separate export segment is not a binding");

  // Shell expansions and empty values are refused locally, before any gate call.
  for (const bad of ["INBOX_PIPELINE_RUN=$RUN git push origin HEAD:dev", "INBOX_PIPELINE_RUN= git push origin HEAD:dev", "INBOX_PIPELINE_RUN=r INBOX_PIPELINE_ROUND=x git push origin HEAD:dev"]) {
    r = gated(bad); assert.match(r.reason!, /literal values/); assert.equal(r.calls.length, 0);
  }
  // Unprotected pushes ignore the assignment entirely.
  r = gated("INBOX_PIPELINE_RUN=$RUN git push origin HEAD:feature"); assert.equal(r.reason, null); assert.equal(r.calls.length, 0);

  // No run anywhere: the office's refusal is passed on with the supported form.
  process.env.SCRATCH_GATE_EXIT = "1";
  r = gated("git push origin HEAD:dev");
  assert.equal(value(r.calls[0]!, "--run"), undefined);
  assert.match(r.reason!, /prefix it with INBOX_PIPELINE_RUN=<run>/);
  r = gated("INBOX_PIPELINE_RUN=named git push origin HEAD:dev");
  assert.doesNotMatch(r.reason!, /prefix it with INBOX_PIPELINE_RUN/);
});

test("installed harness hooks read the run from the command; a Git push passes its env to pre-push", (t) => {
  const s = scratch(t); const remote = join(s.root, "remote.git");
  assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
  s.git("remote", "add", "origin", remote); s.install();
  const clean: Record<string, string | undefined> = { ...process.env };
  for (const name of ["INBOX_PIPELINE_RUN", "INBOX_PIPELINE_ROUND", "SCRATCH_GATE_EXIT"]) delete clean[name];
  for (const mode of ["claude", "codex"]) {
    const settings = JSON.parse(readFileSync(join(s.repo, mode === "claude" ? ".claude/settings.json" : ".codex/hooks.json"), "utf8"));
    const before = s.readCalls().length;
    const r = spawnSync("/bin/sh", ["-c", settings.hooks.PreToolUse[0].hooks[0].command], { cwd: s.repo, env: clean, input: JSON.stringify({ session_id: "scratch", tool_name: "Bash", tool_input: { command: "INBOX_PIPELINE_RUN=5cc68709 git push origin HEAD:dev" } }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {});
    const args = s.readCalls()[before]!; assert.equal(args[args.indexOf("--run") + 1], "5cc68709");
  }
  const before = s.readCalls().length;
  const push = spawnSync("git", ["-C", s.repo, "push", "origin", "HEAD:dev"], { encoding: "utf8", env: { ...clean, INBOX_PIPELINE_RUN: "from-push", INBOX_PIPELINE_ROUND: "2" } });
  assert.equal(push.status, 0, push.stderr);
  const args = s.readCalls()[before]!; assert.equal(args[args.indexOf("--run") + 1], "from-push"); assert.equal(args[args.indexOf("--round") + 1], "2");
});

function fakeNode(root: string, ...parts: string[]): string {
  const file = join(root, ...parts); mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n"); chmodSync(file, 0o755); return realpathSync(file);
}

test("stableNode prefers a non-versioned alias that resolves to the running node, else warns", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stable-node-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const running = fakeNode(root, "Cellar/node@24/24.21.0/bin/node");
  // No alias yet: keep the running (versioned) node and say what that risks.
  const fallback = stableNode(running); assert.equal(fallback.path, running); assert.match(fallback.warning!, /fail silently/);
  // Homebrew's opt symlink resolves to the same file: use it; it survives a keg upgrade.
  mkdirSync(join(root, "opt"), { recursive: true }); symlinkSync("../Cellar/node@24/24.21.0", join(root, "opt/node@24"));
  assert.deepEqual(stableNode(running), { path: join(root, "opt/node@24/bin/node") });
  // After an upgrade the alias still names a node that exists; before re-install the old path would be gone.
  rmSync(join(root, "opt/node@24")); symlinkSync("../Cellar/node@24/24.22.0", join(root, "opt/node@24")); fakeNode(root, "Cellar/node@24/24.22.0/bin/node");
  assert.equal(stableNode(join(root, "Cellar/node@24/24.22.0/bin/node")).path, join(root, "opt/node@24/bin/node"));
  // An alias for a different node is never substituted.
  assert.equal(stableNode(running).path, running);
  assert.ok(stableNode(running).warning);
  // The prefix bin/node is the second choice, and an already unversioned path is kept without a warning.
  const other = fakeNode(root, "Cellar/node/25.0.0/bin/node"); mkdirSync(join(root, "bin"), { recursive: true }); symlinkSync("../Cellar/node/25.0.0/bin/node", join(root, "bin/node"));
  assert.deepEqual(stableNode(other), { path: join(root, "bin/node") });
  const plain = fakeNode(root, "usr/bin/node"); assert.deepEqual(stableNode(plain), { path: plain });
});

test("install keeps the stable node local, marks every generated file, and replaces earlier node paths without duplicates", async (t) => {
  const s = scratch(t); const stale = join(s.root, "Cellar/node@24/24.21.0/bin/node"); const stable = join(s.root, "opt/node@24/bin/node");
  const local = join(realpathSync(s.repo), ".review-inbox-pipeline");
  mkdirSync(join(s.repo, ".claude")); mkdirSync(join(s.repo, ".codex"));
  // v1 shape: harness commands call the runner CLI directly, with a node path that a brew upgrade removed.
  for (const [dir, file, mode] of [[".claude", "settings.json", "claude"], [".codex", "hooks.json", "codex"]]) {
    writeFileSync(join(s.repo, dir!, file!), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `'${stale}' '${join(local, "pipeline-hooks.ts")}' ${mode} '${join(local, "config.json")}'` }, { type: "command", command: "keep-me" }] }] } }));
  }
  const warnings: string[] = [];
  s.install({ node: stable, warn: (m: string) => warnings.push(m) }); s.install({ node: stable });
  for (const [dir, file, mode] of [[".claude", "settings.json", "claude"], [".codex", "hooks.json", "codex"]]) {
    const hooks = JSON.parse(readFileSync(join(s.repo, dir!, file!), "utf8")).hooks.PreToolUse.flatMap((g: any) => g.hooks).map((h: any) => h.command);
    assert.deepEqual(hooks, ["keep-me", HARNESS_COMMANDS[mode as "claude" | "codex"]]);
  }
  // The node is this machine's: only the ignored local file names it, and the untracked pre-push reads it there.
  assert.equal(readFileSync(join(local, "node"), "utf8"), `${stable}\n`);
  const wrapper = readFileSync(join(s.repo, ".git/hooks/pre-push"), "utf8"); assert.match(wrapper, /"\$node" '[^']*review-inbox-pipeline.mjs' pre-push/);
  for (const text of [wrapper, readFileSync(join(local, "pipeline-hooks.ts"), "utf8"), readFileSync(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"), "utf8"), readFileSync(join(s.repo, ".claude/hooks/review-inbox-pipeline.mjs"), "utf8"), readFileSync(join(s.repo, ".claude/hooks/review-inbox-pipeline.sh"), "utf8")]) {
    assert.match(text, /GENERATED by the Review Inbox pipeline installer; do not edit\. Regenerate with: .*pipeline install-hooks/);
    assert.ok(text.includes("review-inbox-pipeline-guard-v2")); assert.ok(!text.includes(stale));
  }
  for (const file of [".pi/extensions/review-inbox-pipeline.ts", ".claude/hooks/review-inbox-pipeline.mjs", ".claude/hooks/review-inbox-pipeline.sh"]) assert.ok(!readFileSync(join(s.repo, file), "utf8").includes(stable), `${file} is committed: no node path`);
  for (const file of ["config.json", "manifest.json"]) assert.match(JSON.parse(readFileSync(join(local, file), "utf8"))._generated, /do not edit\. Regenerate with: .*install-hooks/);
  assert.equal(JSON.parse(readFileSync(join(local, "config.json"), "utf8")).inboxCommand[0], s.config.inboxCommand[0], "an explicit inbox command is kept");
  // Re-installing from the installed runner copy does not stack headers.
  const copy = await import(join(local, "pipeline-hooks.ts")); copy.installHooks(s.repo, { inboxCommand: s.config.inboxCommand, node: stable });
  const runnerText = readFileSync(join(local, "pipeline-hooks.ts"), "utf8"); assert.equal(runnerText.match(/^\/\/ GENERATED /gm)!.length, 1);
  assert.match(runnerText, /^\/\/ review-inbox-pipeline-guard-v2\n\/\/ GENERATED /);
  // Uninstall removes our entries whichever node wrote them.
  s.install({ uninstall: true, node: "/another/node" });
  for (const [dir, file] of [[".claude", "settings.json"], [".codex", "hooks.json"]]) assert.deepEqual(JSON.parse(readFileSync(join(s.repo, dir!, file!), "utf8")).hooks.PreToolUse[0].hooks.map((h: any) => h.command), ["keep-me"]);
});

test("Claude and Codex installed hooks emit deny/reason when CLI unavailable, ordinary tools remain untouched", (t) => {
  const s = scratch(t); s.install({ inboxCommand: ["/nonexistent/inbox"] });
  for (const mode of ["claude", "codex"]) {
    const settings = JSON.parse(readFileSync(join(s.repo, mode === "claude" ? ".claude/settings.json" : ".codex/hooks.json"), "utf8"));
    const invoke = (command: string) => spawnSync("/bin/sh", ["-c", settings.hooks.PreToolUse[0].hooks[0].command], { cwd: s.repo, input: JSON.stringify({ session_id: "scratch", tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
    const r = invoke("git push origin HEAD:dev"); assert.equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout); assert.equal(output.hookSpecificOutput.permissionDecision, "deny"); assert.match(output.hookSpecificOutput.permissionDecisionReason, /Restart the office/);
    assert.deepEqual(JSON.parse(invoke("npm test && git commit -m local").stdout), {});
    assert.deepEqual(JSON.parse(invoke("git push origin HEAD:feature").stdout), {});
  }
});

test("merge safety: feature merges allowed; protected fast-forward binds source, branch switches and -C cannot hide it", (t) => {
  const s = scratch(t);
  assert.deepEqual(commandBoundaries("git merge main", s.repo, s.config), []);
  const commands = [`git checkout dev && git merge feature`, `git -C '${s.repo}' merge feature`];
  for (const c of commands) {
    if (c.includes("-C")) s.git("checkout", "dev");
    const b = commandBoundaries(c, s.repo, s.config); assert.equal(b.length, 1); assert.equal(b[0]!.candidate, s.candidate);
  }
  assert.throws(() => commandBoundaries("git merge --squash feature", s.repo, s.config), /Protected merge/);
  s.git("checkout", "feature"); writeFileSync(join(s.repo, "file"), "feature"); s.git("commit", "-am", "feature");
  s.git("checkout", "dev"); writeFileSync(join(s.repo, "other"), "dev"); s.git("add", "other"); s.git("commit", "-m", "dev");
  assert.throws(() => commandBoundaries("git merge feature", s.repo, s.config), /non-fast-forward/);
});

test("PR target and configured landing-script indirection are guarded before modifying dev", (t) => {
  const s = scratch(t);
  writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ project: "scratch", integrationBranch: "dev", land: { mode: "pinned" }, pipelineHooks: { guardedCommands: [{ command: "./deliver release", operation: "land", ref: "main", candidateArgument: 0 }] } }));
  s.install(); const config = JSON.parse(readFileSync(join(s.repo, ".review-inbox-pipeline/config.json"), "utf8")) as HookConfig;
  assert.equal(commandBoundaries("gh pr create --base main --head feature", s.repo, config)[0]!.operation, "pr");
  assert.deepEqual(commandBoundaries("gh pr create --base feature", s.repo, config), []);
  assert.equal(commandBoundaries(`node /canonical/.claude/hooks/worktree-sync.mjs land '${s.repo}' ${s.candidate}`, s.repo, config)[0]!.operation, "land");
  assert.equal(commandBoundaries("node .claude/hooks/worktree-sync.mjs publish", s.repo, config)[0]!.candidate, s.candidate);
  assert.equal(commandBoundaries(`./deliver release ${s.candidate}`, s.repo, config)[0]!.ref, "refs/heads/main");
  const down = { ...config, inboxCommand: ["/nonexistent/inbox"] };
  assert.match(guardTool(down, { input: { command: `node .claude/hooks/worktree-sync.mjs land '${s.repo}' ${s.candidate}` } }, s.repo, "pi", "scratch")!, /Restart the office/);
  assert.equal(guardTool(down, { input: { command: "node .claude/hooks/worktree-sync.mjs status" } }, s.repo, "pi", "scratch"), null);
});

test("FysikLab adapter auto-guards only the live worktree-sync land/publish delivery paths", (t) => {
  const s = scratch(t);
  writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ project: "fysiklab", integrationBranch: "dev" }));
  s.install(); const config = JSON.parse(readFileSync(join(s.repo, ".review-inbox-pipeline/config.json"), "utf8")) as HookConfig;
  assert.deepEqual(config.guardedCommands.map(c => c.command), ["node .claude/hooks/worktree-sync.mjs land", "node .claude/hooks/worktree-sync.mjs publish", ".claude/hooks/worktree-sync.mjs land", ".claude/hooks/worktree-sync.mjs publish"]);
  const boundary = commandBoundaries(`node .claude/hooks/worktree-sync.mjs land '${s.repo}' ${s.candidate}`, s.repo, config)[0]!;
  assert.equal(boundary.operation, "land"); assert.equal(boundary.candidate, s.candidate);
  for (const command of ["npm run check:changed", "npm run check", "npm run gates", "node space-app/scripts/workflow/workflow.mjs history", "node space-app/scripts/workflow/workflow.mjs returns", "node space-app/scripts/workflow/workflow.mjs audit", "node space-app/scripts/workflow/workflow.mjs record"]) assert.deepEqual(commandBoundaries(command, s.repo, config), []);
});

test("a linked worktree is never an install of its own: install goes on the main checkout, writing nothing first", (t) => {
  const s = scratch(t); const worktree = join(s.root, "worktree"); s.git("worktree", "add", "-b", "linked", worktree);
  assert.throws(() => installHooks(worktree, { inboxCommand: s.config.inboxCommand }), /main checkout \(.*repo space\)/);
  for (const path of [join(worktree, ".claude"), join(worktree, ".review-inbox-pipeline"), join(s.repo, ".git/hooks/pre-push")]) assert.equal(existsSync(path), false);
  assert.deepEqual(installHooks(worktree, { uninstall: true }), [], "nothing to uninstall there either");
});

test("Git itself refuses protected publication while ordinary feature pushes continue during outage", (t) => {
  const s = scratch(t); const remote = join(s.root, "remote.git");
  assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
  s.git("remote", "add", "origin", remote); s.install({ inboxCommand: ["/nonexistent/inbox"] });
  s.git("push", "origin", "HEAD:feature");
  const r = spawnSync("git", ["-C", s.repo, "push", "origin", "HEAD:dev"], { encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Restart the office and retry/);
  assert.equal(spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/dev"]).status, 128);
});

test("installed guards call the real office CLI gate end to end in a scratch repo", { timeout: 60000 }, async (t) => {
  const s = scratch(t); const home = join(s.root, "office-home"); mkdirSync(home);
  const keys = ["HOME", "INBOX_DATA_DIR", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "INBOX_CODEX_ACCOUNT_POLLING", "INBOX_PRESENCE_DISCOVERY", "INBOX_BROWSER_CLEANUP"];
  const saved = keys.map(k => process.env[k]);
  const values = [home, join(s.root, "office-data"), "/nonexistent", "/usr/bin/false", "0", "0", "0"];
  keys.forEach((k, i) => process.env[k] = values[i]);
  t.after(() => keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }));
  const graph = { version: 1, id: "scratch", label: "Scratch wave", entry: "checks", fields: [], nodes: [
    { id: "checks", label: "Check pinned bytes", kind: "step", source: "builtin:check", evidence: ["check"] },
    { id: "deliver", label: "Publish dev", kind: "delivery", delivery: "dev" }], edges: [{ id: "checked", from: "checks", to: "deliver" }] };
  writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ project: "scratch", integrationBranch: "dev", pipeline: graph, land: { mode: "pinned" } }));
  installHooks(s.repo); // Real inbox executable, not the fake unit-test gate.
  s.git("add", "."); s.git("commit", "-m", "Install guards before pinning the wave");
  const sha = s.git("rev-parse", "HEAD");
  const remote = join(s.root, "remote.git"); assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
  s.git("remote", "add", "origin", remote);
  const db = openDatabase(join(s.root, "office.sqlite")); t.after(() => db.close());
  const inbox = new Inbox(db, join(s.root, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const live: LiveAgent[] = ["lead", "crew"].map((id, i) => ({ harness: "claude", sessionId: `scratch-${id}`, paneId: `scratch-pane-${i}`, cwd: s.repo, status: "idle", title: null, name: id }));
  const none = async (): Promise<never> => { throw new Error("No real herdr in scratch office"); };
  const world = new World(db, { available: () => true, live: () => live, prompt: async () => {}, notify: async () => {}, createWorktree: none, startAgent: none, closePane: none, removeWorktree: none }, () => inbox.state());
  const agents = world.state().agents;
  const team = await world.createTeam({ name: "Scratch first mate", standing: true });
  for (const a of agents) world.updateAgent(a.id, { teamId: team.id, role: a.paneId === "scratch-pane-0" ? "lead" : "member" });
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; assert.notEqual(port, 4870); await new Promise<void>(r => probe.close(() => r()));
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  let closed = false;
  const close = async () => { if (!closed) { closed = true; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
  t.after(close);
  const env = { PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", INBOX_DATA_DIR: join(s.root, "office-data"), INBOX_URL: `http://127.0.0.1:${port}`, HERDR_SOCKET_PATH: "/nonexistent", HERDR_BIN_PATH: "/usr/bin/false", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0", CLAUDE_CODE_SESSION_ID: "scratch-lead" };
  const exec = async (command: string, args: string[], input?: string, extra: Record<string, string> = {}) => {
    const child = spawn(command, args, { cwd: s.repo, env: { ...env, ...extra } });
    let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b); child.stdin.end(input);
    const [code] = await once(child, "close"); return { code, stdout, stderr };
  };
  const cli = async (args: string[]) => exec(process.execPath, [resolve("bin/inbox"), "pipeline", ...args]);
  const noRunPush = await exec("git", ["push", "origin", "HEAD:dev"]); assert.notEqual(noRunPush.code, 0); assert.match(noRunPush.stderr, /name the pipeline run/);
  const start = await cli(["start", "--candidate", sha, "--base", sha]); assert.equal(start.code, 0, start.stderr);
  const run = JSON.parse(start.stdout);
  const hook = async (command: string, options: { session?: string; run?: string; round?: string; cwd?: string } = {}) => {
    const result = await exec(process.execPath, [join(s.repo, ".review-inbox-pipeline/pipeline-hooks.ts"), "claude", join(s.repo, ".review-inbox-pipeline/config.json")], JSON.stringify({ session_id: options.session ?? "scratch-lead", cwd: options.cwd ?? s.repo, tool_name: "Bash", tool_input: { command } }), { INBOX_PIPELINE_RUN: options.run ?? run.id, ...(options.round ? { INBOX_PIPELINE_ROUND: options.round } : {}) });
    assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const denial = (response: any, reason: RegExp) => { assert.equal(response.hookSpecificOutput?.permissionDecision, "deny"); assert.match(response.hookSpecificOutput.permissionDecisionReason, reason); };
  denial(await hook("git push origin HEAD:dev"), /checks: ready/);
  const done = await cli(["done", run.id, "checks", "--check", "git rev-parse HEAD", "--exit-code", "0", "--notes", "Scratch checks pass at the exact candidate"]); assert.equal(done.code, 0, done.stderr);
  const cliGate = await cli(["gate", "--operation", "push", "--repo", s.repo, "--ref", "refs/heads/dev", "--candidate", sha, "--run", run.id]); assert.equal(cliGate.code, 0, cliGate.stderr); assert.equal(JSON.parse(cliGate.stdout).allowed, true);
  assert.deepEqual(await hook("git push origin HEAD:dev"), {});
  denial(await hook("git push origin HEAD:dev", { run: "" }), /name the pipeline run[^]*prefix it with INBOX_PIPELINE_RUN=<run>/);
  assert.deepEqual(await hook(`INBOX_PIPELINE_RUN=${run.id} git push origin HEAD:dev`, { run: "" }), {}, "inline run, no run in the harness env");
  assert.deepEqual(await hook(`INBOX_PIPELINE_RUN=${run.id} git push origin HEAD:dev`, { run: "", round: "2" }), {}, "an env round is not paired with a different inline run");
  denial(await hook(`INBOX_PIPELINE_RUN=${run.id} INBOX_PIPELINE_ROUND=2 git push origin HEAD:dev`, { run: "" }), /stale run round/);
  denial(await hook(`INBOX_PIPELINE_RUN=${run.id} git push origin HEAD:main && git push origin HEAD:dev`, { run: "" }), /ref is not/);
  denial(await hook("git push origin HEAD:dev", { session: "scratch-crew" }), /first mate/);
  denial(await hook("git push origin HEAD:main"), /ref is not/);
  denial(await hook("gh pr create --base main"), /release\/PR\/merge/);
  denial(await hook("git push origin HEAD:dev", { round: "2" }), /stale run round/);
  const other = join(s.root, "other-repository"); assert.equal(spawnSync("git", ["clone", s.repo, other]).status, 0);
  denial(await hook("git push origin HEAD:dev", { cwd: other }), /repository does not match/);
  denial(await hook(`git push origin ${s.candidate}:dev`), /stale candidate/);
  assert.deepEqual(await hook(`node .claude/hooks/worktree-sync.mjs land '${s.repo}' ${sha}`), {});
  denial(await hook(`node .claude/hooks/worktree-sync.mjs land '${s.repo}' ${sha}`, { run: "" }), /name the pipeline run/);
  assert.deepEqual(await hook(`INBOX_PIPELINE_RUN=${run.id} node .claude/hooks/worktree-sync.mjs land '${s.repo}' ${sha}`, { run: "" }), {}, "the Emil case: run only inline on land");
  const push = await exec("git", ["push", "origin", "HEAD:dev"], undefined, { INBOX_PIPELINE_RUN: run.id }); assert.equal(push.code, 0, push.stderr);
  assert.equal(spawnSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/dev"], { encoding: "utf8" }).stdout.trim(), sha);
  assert.equal(world.pipelines.get(run.id).state, "open", "an allowed Git push is not a pipeline delivery receipt");
  s.git("branch", "-f", "dev", sha);
  assert.deepEqual(await hook("node .claude/hooks/worktree-sync.mjs publish"), {});
  const stalePush = await exec("git", ["push", "--force", "origin", `${s.candidate}:dev`], undefined, { INBOX_PIPELINE_RUN: run.id }); assert.notEqual(stalePush.code, 0); assert.match(stalePush.stderr, /stale candidate/);
  writeFileSync(join(s.repo, "file"), "Changed bytes invalidate the gate");
  denial(await hook("git push origin HEAD:dev"), /stale candidate|commit intended bytes/);
  s.git("checkout", "--", "file");
  assert.deepEqual(await hook("git push origin HEAD:dev"), {});
  await close();
  denial(await hook("git push origin HEAD:dev"), /Restart the office and retry/);
  assert.deepEqual(await hook("npm test && git push origin HEAD:offline-feature"), {});
  const feature = await exec("git", ["push", "origin", "HEAD:offline-feature"]); assert.equal(feature.code, 0, feature.stderr);
  const protectedPush = await exec("git", ["push", "origin", "HEAD:main"], undefined, { INBOX_PIPELINE_RUN: run.id }); assert.notEqual(protectedPush.code, 0); assert.match(protectedPush.stderr, /Restart the office and retry/);
  assert.equal(spawnSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/dev"], { encoding: "utf8" }).stdout.trim(), sha);
});

// FysikLab's .pi/tsconfig.json settings: deliberately no allowImportingTsExtensions.
const fysiklabPiTsconfig = {
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: false, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, types: ["node"], typeRoots: ["../space-app/node_modules/@types"], paths: {
    "@earendil-works/pi-coding-agent": ["../space-app/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
    typebox: ["../space-app/node_modules/typebox/build/index.d.mts"]
  } }, include: ["extensions/*.ts", "../space-app/lib/dev/internal/node-sqlite.d.ts"]
};

test("generated Pi extension typechecks with FysikLab settings and loads with metadata entirely absent", async (t) => {
  const s = scratch(t); s.install();
  rmSync(join(s.repo, ".review-inbox-pipeline"), { recursive: true });
  mkdirSync(join(s.repo, "space-app")); symlinkSync(resolve("node_modules"), join(s.repo, "space-app/node_modules"));
  writeFileSync(join(s.repo, ".pi/tsconfig.json"), JSON.stringify(fysiklabPiTsconfig));
  const result = spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", join(s.repo, ".pi/tsconfig.json")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const extension = await import(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"));
  let handler: any; extension.default({ on(_: string, callback: any) { handler = callback; } });
  const ctx = { cwd: s.repo, sessionManager: { getSessionFile: () => undefined } };
  const denied = await handler({ input: { command: "git push origin HEAD:dev" } }, ctx);
  assert.equal(denied.block, true); assert.match(denied.reason, /pipeline guard runner missing at .*; reinstall/);
  assert.equal(await handler({ input: { command: "git push origin HEAD:feature" } }, ctx), undefined);
});

for (const failure of ["runner missing", "runner invalid", "config missing", "config malformed", "config invalid"]) {
  test(`all installed harnesses fail closed only at installed boundaries: ${failure}`, async (t) => {
    const s = scratch(t);
    writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ project: "fysiklab", pipelineHooks: { protectedRefs: ["release"], guardedCommands: [{ command: "./deliver ship", operation: "publish", ref: "release" }] } }));
    s.install({ inboxCommand: ["/nonexistent/inbox"] });
    const runner = join(s.repo, ".review-inbox-pipeline/pipeline-hooks.ts");
    const config = join(s.repo, ".review-inbox-pipeline/config.json");
    if (failure === "runner missing") rmSync(runner);
    if (failure === "runner invalid") writeFileSync(runner, "throw new Error('broken runner');\n");
    if (failure === "config missing") rmSync(config);
    if (failure === "config malformed") writeFileSync(config, "{");
    if (failure === "config invalid") writeFileSync(config, JSON.stringify({ marker: "review-inbox-pipeline-guard-v2", protectedRefs: [], guardedCommands: "broken", inboxCommand: [] }));
    const extension = await import(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"));
    let handler: any; extension.default({ on(_: string, callback: any) { handler = callback; } });
    const ctx = { cwd: s.repo, sessionManager: { getSessionFile: () => undefined } };
    const protectedCommands = ["git push origin HEAD:dev", "git push origin HEAD:release", "git switch dev && git merge feature", "gh pr create --base main", "node .claude/hooks/worktree-sync.mjs publish", "./deliver ship"];
    const ordinaryCommands = ["git push origin HEAD:feature", "npm test && git commit -m local", "git merge dev", "gh pr create --base feature", "node .claude/hooks/worktree-sync.mjs status"];
    for (const mode of ["pi", "claude", "codex"]) {
      const invoke = async (input: any) => {
        if (mode === "pi") return handler(input, ctx);
        const settings = JSON.parse(readFileSync(join(s.repo, mode === "codex" ? ".codex/hooks.json" : ".claude/settings.json"), "utf8"));
        const command = settings.hooks.PreToolUse[0].hooks[0].command;
        const result = spawnSync("/bin/sh", ["-c", command], { cwd: s.repo, input: JSON.stringify(input), encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
      };
      for (const command of protectedCommands) {
        const response = await invoke({ input: { command } });
        assert.equal(mode === "pi" ? response.block : response.hookSpecificOutput.permissionDecision, mode === "pi" ? true : "deny");
        assert.match(mode === "pi" ? response.reason : response.hookSpecificOutput.permissionDecisionReason, /pipeline guard runner missing at .*; reinstall/);
      }
      for (const command of ordinaryCommands) assert.deepEqual(await invoke({ input: { command } }), mode === "pi" ? undefined : {});
      assert.deepEqual(await invoke({ input: { path: "file" } }), mode === "pi" ? undefined : {});
    }
    const prePush = (ref: string) => spawnSync(join(s.repo, ".git/hooks/pre-push"), [], { cwd: s.repo, input: `x ${s.candidate} refs/heads/${ref} ${s.candidate}\n`, encoding: "utf8" });
    assert.equal(prePush("feature").status, 0);
    const denied = prePush("release"); assert.equal(denied.status, 1); assert.match(denied.stderr, /pipeline guard runner missing at .*; reinstall/);
    // Reinstall repairs runtime metadata while retaining the snapshot's custom policy,
    // even if the adapter no longer advertises that protection.
    rmSync(join(s.repo, "orchestrator.json")); s.install();
    const repaired = JSON.parse(readFileSync(config, "utf8"));
    assert.ok(repaired.protectedRefs.includes("refs/heads/release"));
    assert.ok(repaired.guardedCommands.some((c: any) => c.command === "./deliver ship"));
  });
}

test("v1 reinstall replaces owned extension and commands cleanly, keeps boundaries and original Git hook", (t) => {
  const s = scratch(t); const hook = join(s.repo, ".git/hooks/pre-push");
  writeFileSync(hook, "#!/bin/sh\nexit 7\n"); chmodSync(hook, 0o755);
  s.install();
  const local = join(s.repo, ".review-inbox-pipeline");
  const manifestPath = join(local, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.policy;
  manifest.marker = "review-inbox-pipeline-guard-v1"; manifest.wrapper = manifest.wrapper.replaceAll("guard-v2", "guard-v1");
  writeFileSync(manifestPath, JSON.stringify(manifest)); writeFileSync(hook, manifest.wrapper);
  const config = JSON.parse(readFileSync(join(local, "config.json"), "utf8")); config.marker = manifest.marker; config.protectedRefs.push("refs/heads/release");
  writeFileSync(join(local, "config.json"), JSON.stringify(config));
  writeFileSync(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"), `// ${manifest.marker}\nimport { guardTool } from ${JSON.stringify(join(local, "pipeline-hooks.ts"))};\n`);
  rmSync(join(s.repo, ".claude/hooks/review-inbox-pipeline.mjs"));
  for (const mode of ["claude", "codex"]) {
    const path = join(s.repo, mode === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `'${process.execPath}' '${join(realpathSync(local), "pipeline-hooks.ts")}' ${mode} '${join(realpathSync(local), "config.json")}'` }, { type: "command", command: "keep-me" }] }] } }));
  }
  s.install(); s.install();
  assert.match(readFileSync(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"), "utf8"), /^\/\/ review-inbox-pipeline-guard-v2\n/);
  assert.ok(JSON.parse(readFileSync(join(local, "config.json"), "utf8")).protectedRefs.includes("refs/heads/release"));
  for (const path of [".claude/settings.json", ".codex/hooks.json"]) {
    const hooks = JSON.parse(readFileSync(join(s.repo, path), "utf8")).hooks.PreToolUse.flatMap((group: any) => group.hooks);
    assert.equal(hooks.length, 2); assert.equal(hooks[0].command, "keep-me"); assert.match(hooks[1].command, /exec sh "\$l" (claude|codex); /); assert.ok(hooks[1].command.includes(".claude/hooks/review-inbox-pipeline.sh"));
  }
  s.install({ uninstall: true }); assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\nexit 7\n");
  assert.equal(existsSync(join(s.repo, ".claude/hooks/review-inbox-pipeline.mjs")), false);
});

test("installed Pi project extension returns a block, never auto-allows ordinary tools", async (t) => {
  const s = scratch(t); s.install({ inboxCommand: ["/nonexistent/inbox"] });
  const extension = await import(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"));
  let handler: any;
  extension.default({ on(event: string, callback: any) { assert.equal(event, "tool_call"); handler = callback; } });
  const ctx = { cwd: s.repo, sessionManager: { getSessionFile: () => "/scratch/session.jsonl" } };
  const denial = await handler({ toolName: "bash", input: { command: "git push origin HEAD:main" } }, ctx);
  assert.equal(denial.block, true); assert.match(denial.reason, /Restart the office/);
  assert.equal(await handler({ toolName: "bash", input: { command: "npm test && git push origin HEAD:feature" } }, ctx), undefined);
  assert.equal(await handler({ toolName: "read", input: { path: "file" } }, ctx), undefined);
});

// A FysikLab-shaped repo: the main checkout (Mission Control, never a lane), one declared fix-comments
// lane, one undeclared lane, and a run team's checkout. All scratch; the office is a fake gate.
function lanes(t: { after: (fn: () => void) => void }) {
  const s = scratch(t); const remote = join(s.root, "remote.git");
  assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
  const wt = (name: string) => { const path = join(s.root, name); s.git("worktree", "add", "-b", name, path, "dev"); return realpathSync(path); };
  writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ project: "fysiklab", integrationBranch: "dev",
    lanes: [{ name: "einstein", worktree: "../einstein" }, { name: "galilei", worktree: "../galilei" }, { name: "mission-control", worktree: "." }],
    pipelineHooks: { laneDelivery: { lanes: ["einstein"], policyPaths: ["guarded/**"] } } }));
  s.git("checkout", "dev"); s.git("add", "orchestrator.json"); s.git("commit", "-m", "Declare lanes");
  s.git("remote", "add", "origin", remote); s.git("push", "origin", "dev"); s.git("fetch", "origin");
  const einstein = wt("einstein"); const galilei = wt("galilei"); const team = wt("team");
  const commit = (checkout: string, path: string, text: string) => {
    mkdirSync(join(checkout, path, ".."), { recursive: true }); writeFileSync(join(checkout, path), text);
    const g = (...args: string[]) => { const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    g("add", path); g("-c", "user.name=Scratch", "-c", "user.email=scratch@invalid", "commit", "-m", `Change ${path}`); return g("rev-parse", "HEAD");
  };
  const exit = process.env.SCRATCH_GATE_EXIT; process.env.SCRATCH_GATE_EXIT = "1"; // The fake office refuses everything it is asked.
  const run = process.env.INBOX_PIPELINE_RUN; delete process.env.INBOX_PIPELINE_RUN;
  t.after(() => { if (exit === undefined) delete process.env.SCRATCH_GATE_EXIT; else process.env.SCRATCH_GATE_EXIT = exit; if (run !== undefined) process.env.INBOX_PIPELINE_RUN = run; });
  s.install(); const config = JSON.parse(readFileSync(join(s.repo, ".review-inbox-pipeline/config.json"), "utf8")) as HookConfig;
  const land = (checkout: string, sha: string, prefix = "") => {
    const before = s.readCalls().length;
    const reason = guardTool(config, { tool_input: { command: `${prefix}node .claude/hooks/worktree-sync.mjs land '${checkout}' ${sha}` } }, s.repo, "claude", "scratch");
    return { reason, calls: s.readCalls().slice(before) };
  };
  return { ...s, remote, einstein, galilei, team, commit, config, land };
}

test("a declared lane lands and publishes its own fix with no run and no office; the class comes from its checkout", (t) => {
  const s = lanes(t); const fix = s.commit(s.einstein, "app/fix.ts", "fixed");
  assert.deepEqual(s.config.lanes, [{ name: "einstein", checkout: s.einstein }]);
  const down = { ...s.config, inboxCommand: ["/nonexistent/inbox"] };
  assert.equal(guardTool(down, { tool_input: { command: `node .claude/hooks/worktree-sync.mjs land '${s.einstein}' ${fix}` } }, s.repo, "pi", "scratch"), null, "an office outage does not block a lane");
  const landed = s.land(s.einstein, fix); assert.equal(landed.reason, null); assert.equal(landed.calls.length, 0, "a lane's own delivery never asks the office");
  // worktree-sync fast-forwards dev in the main checkout and pushes it from there; Git's pre-push sees the record.
  s.git("merge", "--ff-only", fix);
  s.install({ inboxCommand: ["/nonexistent/inbox"] });
  const pushed = spawnSync("git", ["-C", s.repo, "push", "origin", "dev:dev"], { encoding: "utf8", env: { ...process.env, INBOX_PIPELINE_RUN: "" } });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(spawnSync("git", ["--git-dir", s.remote, "rev-parse", "refs/heads/dev"], { encoding: "utf8" }).stdout.trim(), fix);
  // The lane may also push from its own checkout directly.
  const second = s.commit(s.einstein, "app/second.ts", "fixed again");
  assert.equal(guardPrePush(down, `refs/heads/einstein ${second} refs/heads/dev ${fix}\n`, s.einstein), null);
});

test("outside a declared lane checkout a missing run is never permission; a lane cannot carry a run or another's commit", (t) => {
  const s = lanes(t); const value = (args: string[], name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  // In-run crew omitting the run variable, from the team's checkout or the main checkout: the office decides, and refuses.
  const work = s.commit(s.team, "app/work.ts", "run work");
  for (const checkout of [s.team, s.repo]) {
    const r = s.land(checkout, work); assert.ok(r.reason); assert.equal(r.calls.length, 1); assert.equal(value(r.calls[0]!, "--run"), undefined);
  }
  // A lane that is not declared for delivery is not a lane here.
  const undeclared = s.commit(s.galilei, "app/g.ts", "fix"); assert.equal(s.land(s.galilei, undeclared).calls.length, 1);
  // A named run is still the run gate's business, with the run passed on.
  const named = s.land(s.team, work, "INBOX_PIPELINE_RUN=r1 "); assert.equal(value(named.calls[0]!, "--run"), "r1");
  // A lane checkout never delivers a run, and never someone else's commit.
  const fix = s.commit(s.einstein, "app/fix.ts", "fixed");
  let r = s.land(s.einstein, fix, "INBOX_PIPELINE_RUN=r1 "); assert.match(r.reason!, /lane checkout/); assert.equal(r.calls.length, 0);
  r = s.land(s.einstein, work); assert.match(r.reason!, /not checked out in lane einstein/); assert.equal(r.calls.length, 0);
  // Unresolvable checkouts and a publish of an unrecorded commit ask the office.
  assert.equal(s.land(join(s.root, "missing"), work).calls.length, 1);
  assert.match(guardPrePush(s.config, `refs/heads/dev ${work} refs/heads/dev ${"0".repeat(40)}\n`, s.repo)!, /Restart the office/);
  // A plain git push from the main checkout is Mission Control's, not a lane's.
  s.git("merge", "--ff-only", fix);
  assert.ok(guardTool(s.config, { tool_input: { command: "git push origin dev:dev" } }, s.repo, "claude", "scratch"));
});

test("lane fixes to the guard, the adapter or declared policy paths need a founder waiver from the office", (t) => {
  const s = lanes(t);
  for (const path of ["orchestrator.json", "guarded/rule.ts", ".claude/hooks/review-inbox-pipeline.mjs"]) {
    const sha = s.commit(s.einstein, path, `edit ${Math.random()}`);
    const r = s.land(s.einstein, sha); assert.equal(r.calls.length, 1, path); assert.ok(r.reason, path);
    const args = r.calls[0]!; assert.equal(args.includes("--run"), false); assert.equal(args[args.indexOf("--candidate") + 1], sha);
    s.git("-C", s.einstein, "reset", "-q", "--hard", "HEAD~1");
  }
  // Allowed by the office (a granted waiver for exactly this commit), the same command passes.
  const sha = s.commit(s.einstein, "orchestrator.json", "{}"); process.env.SCRATCH_GATE_EXIT = "0";
  assert.equal(s.land(s.einstein, sha).reason, null);
});

test("lane delivery config: the main checkout is never a lane, other repos refused, reinstall upgrades land boundaries", (t) => {
  const s = lanes(t);
  // Reinstall over a pre-lane install: the land boundary gains its checkout instead of being duplicated.
  const manifestPath = join(s.repo, ".review-inbox-pipeline/manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const c of manifest.policy.guardedCommands) delete c.checkoutArgument;
  writeFileSync(manifestPath, JSON.stringify(manifest)); s.install();
  const config = JSON.parse(readFileSync(join(s.repo, ".review-inbox-pipeline/config.json"), "utf8")) as HookConfig;
  assert.equal(config.guardedCommands.filter((c) => c.command === "node .claude/hooks/worktree-sync.mjs land").length, 1);
  assert.equal(config.guardedCommands.find((c) => c.command === "node .claude/hooks/worktree-sync.mjs land")!.checkoutArgument, 0);
  const adapter = JSON.parse(readFileSync(join(s.repo, "orchestrator.json"), "utf8"));
  const write = (laneDelivery: unknown) => writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ ...adapter, pipelineHooks: { laneDelivery } }));
  write({ lanes: ["mission-control"] }); assert.throws(() => s.install(), /main checkout/);
  write({ lanes: ["curie"] }); assert.throws(() => s.install(), /not a lane/);
  const other = join(s.root, "other"); assert.equal(spawnSync("git", ["init", "-q", other]).status, 0);
  writeFileSync(join(s.repo, "orchestrator.json"), JSON.stringify({ ...adapter, lanes: [{ name: "einstein", worktree: "../other" }], pipelineHooks: { laneDelivery: { lanes: ["einstein"] } } }));
  assert.throws(() => s.install(), /another repository/);
  // Removing the declaration removes the permission on reinstall; policy paths stay.
  write(undefined); s.install();
  const after = JSON.parse(readFileSync(join(s.repo, ".review-inbox-pipeline/config.json"), "utf8")) as HookConfig;
  assert.deepEqual(after.lanes, []); assert.deepEqual(after.policyPaths, ["guarded/**"]);
});
