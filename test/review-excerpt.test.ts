import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewExcerpt } from "../src/server/review-excerpt.ts";
import { Activity, claudeHookEvents } from "../src/server/activity.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "meeting-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout"); mkdirSync(cwd);
  writeFileSync(join(cwd, "lesson.ts"), Array.from({ length: 30 }, (_, i) => `const beat${i} = ${i};`).join("\n"));
  return { root, cwd };
}

test("projector is a bounded excerpt, never env, credentials, binary, oversized or outside checkout", (t) => {
  const { root, cwd } = fixture(t);
  const excerpt = reviewExcerpt(cwd, "lesson.ts", 4)!;
  assert.equal(excerpt.path, "lesson.ts"); assert.equal(excerpt.startLine, 4); assert.equal(excerpt.lines.length, 12);
  assert.equal(excerpt.lines[0], "const beat3 = 3;");
  assert.deepEqual(reviewExcerpt(cwd, join(cwd, "lesson.ts"), 4), excerpt, "absolute paths also work under a symlinked temp directory");
  symlinkSync(cwd, join(root, "checkout-alias"));
  assert.deepEqual(reviewExcerpt(join(root, "checkout-alias"), join(root, "checkout-alias", "lesson.ts"), 4), excerpt);
  for (const path of [".env", ".env.local", ".env.ts", "credentials.ts", "ordinary.ts", "binary.ts", "large.ts"]) {
    writeFileSync(join(cwd, path), path === "ordinary.ts" ? 'const api_key = "do-not-show";' : path === "binary.ts" ? "\0hidden" : path === "large.ts" ? "x".repeat(140000) : "secret");
    assert.equal(reviewExcerpt(cwd, path), null, path);
  }
  writeFileSync(join(root, "outside.ts"), "private data");
  symlinkSync(join(root, "outside.ts"), join(cwd, "linked.ts"));
  symlinkSync(join(cwd, ".env.ts"), join(cwd, "alias.ts"));
  assert.equal(reviewExcerpt(cwd, "../outside.ts"), null);
  assert.equal(reviewExcerpt(cwd, join(root, "outside.ts")), null);
  assert.equal(reviewExcerpt(cwd, "linked.ts"), null);
  assert.equal(reviewExcerpt(cwd, "alias.ts"), null);
  assert.equal(reviewExcerpt(cwd, "missing.ts"), null);
});

test("helper reads arrive through activity, update the projector, not the parent's doing, and expire", (t) => {
  const { cwd } = fixture(t); const activity = new Activity();
  activity.record("a", { kind: "tool", tool: "edit", input: { path: "parent.ts" } }, 0);
  activity.record("a", { kind: "helper_start", helperId: "h", helperType: "code-reviewer" }, 0);
  const hook = claudeHookEvents({ hook_event_name: "PreToolUse", agent_id: "h", tool_name: "Read", tool_input: { file_path: "lesson.ts", offset: 4 } });
  assert.equal(activity.record("a", hook.events[0]!, 10, cwd), true);
  assert.equal(activity.of("a", 10).doing, "Editing parent.ts");
  assert.equal(activity.of("a", 10).helpers[0]!.excerpt?.startLine, 4);
  activity.record("a", { ...hook.events[0]!, input: { path: ".env" } }, 20, cwd);
  assert.equal(activity.of("a", 20).helpers[0]!.excerpt, null, "a rejected read clears the previous slide");
  activity.record("a", hook.events[0]!, 30, cwd);
  assert.equal(activity.of("a", 31 * 60_000).helpers.length, 0);
  activity.record("a", { kind: "helper_stop", helperId: "h" }, 40);
  assert.equal(activity.of("a", 40).helpers.length, 0);
  activity.record("a", { kind: "tool", tool: "agents", callId: "p", input: { calls: [{ name: ".claude/agents/review-code.md" }] } }, 50);
  activity.record("a", { ...hook.events[0]!, helperId: "p:0" }, 60, cwd);
  assert.ok(activity.of("a", 60).helpers[0]!.excerpt);
  activity.record("a", { kind: "tool_end", callId: "p" }, 65);
  assert.deepEqual(activity.of("a", 65).helpers, [], "Pi tool completion releases its review helpers");
  activity.record("a", { kind: "helper_start", helperId: "builder", helperType: "builder" }, 66);
  activity.record("a", { ...hook.events[0]!, helperId: "builder" }, 67, cwd);
  assert.equal(activity.of("a", 67).helpers[0]!.excerpt, undefined, "ordinary helpers never project their source");
  activity.record("a", { kind: "idle" }, 70);
  assert.deepEqual(activity.of("a", 70).helpers, []);
});
