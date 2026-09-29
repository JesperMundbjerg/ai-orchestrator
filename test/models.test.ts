import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { claudeTranscriptModel, codexRolloutModel, piSessionModel, SessionFiles } from "../src/server/models.ts";
import { World } from "../src/server/world.ts";
import { modelLabel } from "../src/shared/models.ts";

const lines = (...entries: object[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");
const dir = () => mkdtempSync(join(tmpdir(), "models-test-"));

// Shaped like the files on a real machine: Pi session v3, Codex rollout, Claude Code transcript.
const pi = {
  start: { type: "session", version: 3, id: "dispatch", cwd: "/repo" },
  change: (provider: string, modelId: string) => ({ type: "model_change", provider, modelId }),
  reply: (provider: string, model: string) => ({ type: "message", message: { role: "assistant", provider, model, content: [] } }),
  user: { type: "message", message: { role: "user", content: [{ type: "text", text: "model is a word here" }] } },
};
const codexTurn = (model: string) => ({ type: "turn_context", payload: { model, effort: "low", cwd: "/repo" } });
const claudeReply = (model: string) => ({ type: "assistant", message: { model, content: [] } });

test("a model id reads as the specific model, not just its family", () => {
  assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("claude-sonnet-5-5[1m]"), "Sonnet 5.5 (1M)");
  assert.equal(modelLabel("anthropic/claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel("gpt-6"), "GPT-6");
  assert.equal(modelLabel("openai-codex/gpt-6-astra"), "GPT-6 Astra");
  assert.equal(modelLabel("gpt-5.6-sol"), "GPT-5.6 Sol");
  assert.equal(modelLabel("gpt-4o-mini"), "GPT-4o Mini");
  assert.equal(modelLabel("gemini-3-pro"), "Gemini 3 Pro");
  assert.equal(modelLabel("o3"), "o3");
});

test("Pi's session file gives the latest model: a model change, or the model a reply was written by", () => {
  const file = join(dir(), "session.jsonl");
  writeFileSync(file, lines(pi.start, pi.change("openai-codex", "gpt-5.6-sol"), pi.user, pi.reply("openai-codex", "gpt-5.6-sol")));
  assert.deepEqual(piSessionModel(file), { id: "openai-codex/gpt-5.6-sol", label: "GPT-5.6 Sol" });
  appendFileSync(file, lines(pi.change("anthropic", "claude-opus-5-5")));
  assert.equal(piSessionModel(file)?.label, "Opus 5.5", "a switch counts before the next reply");
  appendFileSync(file, lines(pi.user));
  assert.equal(piSessionModel(file)?.id, "anthropic/claude-opus-5-5", "a user message says nothing about the model");
  assert.equal(piSessionModel(join(dir(), "missing.jsonl")), null);
});

test("Codex's rollout gives the model of its latest turn", () => {
  const file = join(dir(), "rollout.jsonl");
  writeFileSync(file, lines({ type: "session_meta", payload: { id: "t1" } }, codexTurn("gpt-6-sol"), { type: "event_msg", payload: {} }, codexTurn("gpt-6")));
  assert.deepEqual(codexRolloutModel(file), { id: "gpt-6", label: "GPT-6" });
});

test("Claude Code's transcript gives the model of its latest real reply", () => {
  const file = join(dir(), "s.jsonl");
  writeFileSync(file, lines(claudeReply("claude-opus-5-5"), claudeReply("<synthetic>")));
  assert.deepEqual(claudeTranscriptModel(file), { id: "claude-opus-5-5", label: "Opus 5.5" });
  // A reply far back behind a long tool output is still found.
  appendFileSync(file, lines({ type: "user", message: { content: "x".repeat(400_000) } }));
  assert.equal(claudeTranscriptModel(file)?.label, "Opus 5.5");
});

test("session files are found by each harness's own naming, read lazily, and read again only when they grow", () => {
  const claude = dir();
  const codex = dir();
  mkdirSync(join(claude, "-repo"));
  writeFileSync(join(claude, "-repo", "c1.jsonl"), lines(claudeReply("claude-sonnet-5-5")));
  mkdirSync(join(codex, "2026", "09", "24"), { recursive: true });
  const rollout = join(codex, "2026", "09", "24", "rollout-2026-09-24T17-34-08-t1.jsonl");
  writeFileSync(rollout, lines(codexTurn("gpt-6")));
  const files = new SessionFiles({ claude, codex });
  assert.equal(files.modelOf("claude", "c1", 0)?.label, "Sonnet 5.5");
  assert.equal(files.modelOf("codex", "t1", 0)?.label, "GPT-6");
  assert.equal(files.modelOf("codex", "../../etc", 0), null, "a session id never becomes a path");
  assert.equal(files.modelOf("manual", "c1", 0), null);

  appendFileSync(rollout, lines(codexTurn("gpt-6-sol")));
  assert.equal(files.modelOf("codex", "t1", 5_000)?.label, "GPT-6", "not looked at again within seconds");
  assert.equal(files.modelOf("codex", "t1", 20_000)?.label, "GPT-6 Sol", "a grown file is read again");
});

test("a Pi agent that never reported its model shows the one its session file records", () => {
  const file = join(dir(), "session.jsonl");
  writeFileSync(file, lines(pi.start, pi.change("anthropic", "claude-opus-5-5")));
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir(), "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const none = async () => { throw new Error("not in this test"); };
  const live = [{ paneId: "p1", harness: "pi" as const, sessionId: file, cwd: "/repo", status: "idle" as const, title: null, name: null }];
  const world = new World(db, { available: () => true, live: () => live, prompt: none, notify: none, createWorktree: none, startAgent: none, closePane: none, removeWorktree: none }, () => inbox.state(), () => new Date(), new SessionFiles({ claude: dir(), codex: dir() }));
  assert.deepEqual(world.state().agents[0]!.model, { id: "anthropic/claude-opus-5-5", label: "Opus 5.5" });
  world.report({ harness: "pi", sessionId: file, paneId: "p1" }, [{ kind: "model", model: { id: "openai/gpt-6", label: "GPT-6" } }]);
  assert.equal(world.state().agents[0]!.model?.label, "GPT-6", "what the harness reports wins over the file");
});

test("a Codex pane herdr gives no session for is found by its folder: the newest rollout that began there", () => {
  const codex = dir();
  const day = join(codex, "2026", "09", "29");
  mkdirSync(day, { recursive: true });
  // Like a real rollout: the first line is a long session_meta (it carries the instructions), then turns.
  const meta = (id: string, cwd: string) => ({ type: "session_meta", payload: { session_id: id, id, cwd, originator: "codex-tui", base_instructions: { text: "x".repeat(60_000) } } });
  const write = (name: string, id: string, cwd: string, model: string, at: number) => {
    const path = join(day, name);
    writeFileSync(path, lines(meta(id, cwd), codexTurn(model)));
    utimesSync(path, at, at);
  };
  const lesson = "/Users/jesper/projects/space-shuttle-cosmology-lesson";
  write("rollout-2026-09-29T20-32-35-a1.jsonl", "a1", lesson, "gpt-6-sol", 1_000);
  write("rollout-2026-09-29T20-36-37-a2.jsonl", "a2", lesson, "gpt-6-astra", 2_000);
  write("rollout-2026-09-29T20-40-00-b1.jsonl", "b1", "/Users/jesper/projects/other", "gpt-6", 3_000);
  const files = new SessionFiles({ claude: dir(), codex });
  assert.deepEqual(files.modelOf("codex", null, 0, lesson), { id: "gpt-6-astra", label: "GPT-6 Astra" });
  assert.equal(files.modelOf("codex", null, 0, "/Users/jesper/projects/other")?.label, "GPT-6");
  assert.equal(files.modelOf("codex", null, 0, "/Users/jesper/projects/nowhere"), null);
  assert.equal(files.modelOf("codex", null, 0, null), null, "without a session or a folder there is nothing to look for");
  assert.equal(files.modelOf("claude", null, 0, lesson), null, "only Codex is found this way");
});
