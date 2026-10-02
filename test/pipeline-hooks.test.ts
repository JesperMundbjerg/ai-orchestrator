import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { commandBoundaries, guardPrePush, guardTool, installHooks, type HookConfig } from "../src/cli/pipeline-hooks.ts";

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

test("Claude and Codex installed hooks emit deny/reason when CLI unavailable, ordinary tools remain untouched", (t) => {
  const s = scratch(t); s.install({ inboxCommand: ["/nonexistent/inbox"] });
  for (const mode of ["claude", "codex"]) {
    const invoke = (command: string) => spawnSync(process.execPath, [join(s.repo, ".review-inbox-pipeline/pipeline-hooks.ts"), mode, join(s.repo, ".review-inbox-pipeline/config.json")], { cwd: s.repo, input: JSON.stringify({ session_id: "scratch", tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
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
  assert.equal(commandBoundaries(`node /canonical/scripts/worktree-sync.mjs land '${s.repo}' ${s.candidate}`, s.repo, config)[0]!.operation, "land");
  assert.equal(commandBoundaries("node scripts/worktree-sync.mjs publish", s.repo, config)[0]!.candidate, s.candidate);
  assert.equal(commandBoundaries(`./deliver release ${s.candidate}`, s.repo, config)[0]!.ref, "refs/heads/main");
  const down = { ...config, inboxCommand: ["/nonexistent/inbox"] };
  assert.match(guardTool(down, { input: { command: `node scripts/worktree-sync.mjs land '${s.repo}' ${s.candidate}` } }, s.repo, "pi", "scratch")!, /Restart the office/);
  assert.equal(guardTool(down, { input: { command: "node scripts/worktree-sync.mjs status" } }, s.repo, "pi", "scratch"), null);
});

test("linked worktree installs local harness files and respects the shared Git pre-push backstop", (t) => {
  const s = scratch(t); const worktree = join(s.root, "worktree"); s.git("worktree", "add", "-b", "linked", worktree);
  installHooks(worktree, { inboxCommand: s.config.inboxCommand });
  assert.equal(existsSync(join(worktree, ".claude/settings.json")), true);
  assert.equal(existsSync(join(s.repo, ".claude/settings.json")), false);
  assert.equal(existsSync(join(s.repo, ".git/hooks/pre-push")), true);
  s.install(); // A second explicit checkout install chains the first shared backstop.
  assert.throws(() => installHooks(worktree, { uninstall: true }), /changed since/);
  s.install({ uninstall: true });
  installHooks(worktree, { uninstall: true });
  assert.equal(existsSync(join(s.repo, ".git/hooks/pre-push")), false);
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

test("installed Pi project extension returns a block, never auto-allows ordinary tools", async (t) => {
  const s = scratch(t); s.install({ inboxCommand: ["/nonexistent/inbox"] });
  const extension = await import(join(s.repo, ".pi/extensions/review-inbox-pipeline.ts"));
  let handler: any;
  extension.default({ on(event: string, callback: any) { assert.equal(event, "tool_call"); handler = callback; } });
  const ctx = { cwd: s.repo, sessionManager: { getSessionFile: () => "/scratch/session.jsonl" } };
  const denial = handler({ toolName: "bash", input: { command: "git push origin HEAD:main" } }, ctx);
  assert.equal(denial.block, true); assert.match(denial.reason, /Restart the office/);
  assert.equal(handler({ toolName: "bash", input: { command: "npm test && git push origin HEAD:feature" } }, ctx), undefined);
  assert.equal(handler({ toolName: "read", input: { path: "file" } }, ctx), undefined);
});
