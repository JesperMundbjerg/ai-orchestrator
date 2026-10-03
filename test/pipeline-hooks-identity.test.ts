import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../src/cli/pipeline-hooks.ts", import.meta.url));

/** A scratch repo, the runner's config pointing at a fake `inbox` that records its argv, and a runner call. */
function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "pipeline-identity-")); const repo = join(root, "repo"); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git("init", "-b", "feature"); git("config", "user.name", "Scratch"); git("config", "user.email", "scratch@invalid");
  writeFileSync(join(repo, "file"), "one"); git("add", "file"); git("commit", "-m", "seed"); git("branch", "dev");
  const calls = join(root, "calls.jsonl"); const gate = join(root, "fake-inbox.mjs"); const configPath = join(root, "config.json");
  writeFileSync(gate, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(calls)},JSON.stringify({argv:process.argv.slice(2),pane:process.env.HERDR_PANE_ID})+'\\n');`);
  writeFileSync(configPath, JSON.stringify({ marker: "review-inbox-pipeline-guard-v1", protectedRefs: ["refs/heads/dev"], guardedCommands: [], inboxCommand: [process.execPath, gate] }));
  /** Run the hook as a harness would; `env` is the whole environment, so none of ours leaks in. */
  function hook(mode: "claude" | "codex", env: Record<string, string>) {
    const input = JSON.stringify({ session_id: "payload-session", tool_name: "Bash", tool_input: { command: "git push origin HEAD:dev" } });
    const r = spawnSync(process.execPath, [RUNNER, mode, configPath], { cwd: repo, env: { PATH: process.env.PATH!, HOME: root, ...env }, input, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {});
    const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
    assert.equal(lines.length, 1, "exactly one gate call"); rmSync(calls);
    const { argv, pane } = JSON.parse(lines[0]!) as { argv: string[]; pane?: string };
    const value = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
    return { harness: value("--harness"), session: value("--session"), pane };
  }
  return { hook };
}

test("a real Claude call asks the gate as claude with the payload's session, even if a Pi session file or pane is set", (t) => {
  const { hook } = setup(t);
  assert.deepEqual(hook("claude", { CLAUDE_CODE_SESSION_ID: "claude-1" }), { harness: "claude", session: "payload-session", pane: undefined });
  assert.deepEqual(hook("claude", { CLAUDE_CODE_SESSION_ID: "claude-1", PI_SESSION_FILE: "/pi/session.jsonl", HERDR_PANE_ID: "w9:p1" }), { harness: "claude", session: "payload-session", pane: "w9:p1" });
});

test("a real Codex call asks the gate as codex with the payload's session, even if a Pi session file or pane is set", (t) => {
  const { hook } = setup(t);
  assert.deepEqual(hook("codex", { CODEX_THREAD_ID: "codex-1" }), { harness: "codex", session: "payload-session", pane: undefined });
  assert.deepEqual(hook("codex", { CODEX_THREAD_ID: "codex-1", PI_SESSION_FILE: "/pi/session.jsonl", HERDR_PANE_ID: "w9:p1" }), { harness: "codex", session: "payload-session", pane: "w9:p1" });
});

test("a Claude hook replayed from Pi's bash tool (PI_SESSION_FILE) asks the gate as pi with Pi's session file, not the payload's UUID", (t) => {
  const { hook } = setup(t);
  assert.deepEqual(hook("claude", { PI_SESSION_FILE: "/pi/session.jsonl" }), { harness: "pi", session: "/pi/session.jsonl", pane: undefined });
  assert.deepEqual(hook("codex", { PI_SESSION_FILE: "/pi/session.jsonl", HERDR_PANE_ID: "w9:p1" }), { harness: "pi", session: "/pi/session.jsonl", pane: "w9:p1" });
});

test("a hook bridged from the Pi process itself sends no harness or session, so the pane names the caller", (t) => {
  const { hook } = setup(t);
  // Pi sets PI_SESSION_FILE only in its bash tool's env, so the bridge's process has just the pane.
  assert.deepEqual(hook("claude", { HERDR_PANE_ID: "w9:p1" }), { harness: undefined, session: undefined, pane: "w9:p1" });
  assert.deepEqual(hook("codex", { HERDR_PANE_ID: "w9:p1" }), { harness: undefined, session: undefined, pane: "w9:p1" });
  // Another harness's variable is not this one's own: claude mode with only a Codex thread still has no Claude id.
  assert.deepEqual(hook("claude", { CODEX_THREAD_ID: "codex-1", HERDR_PANE_ID: "w9:p1" }), { harness: undefined, session: undefined, pane: "w9:p1" });
});

test("with none of these variables the payload's session is used unchanged", (t) => {
  const { hook } = setup(t);
  assert.deepEqual(hook("claude", {}), { harness: "claude", session: "payload-session", pane: undefined });
  assert.deepEqual(hook("codex", {}), { harness: "codex", session: "payload-session", pane: undefined });
});
