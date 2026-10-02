import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CrewTree } from "../src/shared/crewtree.ts";
import type { Team } from "../src/shared/types.ts";
import { codexHeaderReadings } from "../src/shared/usage.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { OfficeNotices } from "../src/server/notices.ts";
import { Usage, type UsageRoots } from "../src/server/usage.ts";

const NOW = new Date("2026-10-02T15:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const iso = (d: Date) => d.toISOString();

function roots(): UsageRoots {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const r = { claude: join(dir, "claude"), codex: join(dir, "codex"), pi: join(dir, "pi"), claudeJson: join(dir, "claude.json") };
  for (const d of [r.claude, r.codex, r.pi]) mkdirSync(d, { recursive: true });
  return r;
}

const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const usage = (r: UsageRoots, now = () => NOW) => new Usage(new DatabaseSync(":memory:"), now, r);
const meter = (u: Usage, id: string) => u.meters().find((m) => m.id === id)!;

test("a reading is kept per meter; an older one never overwrites a newer, and one goes stale after 30 minutes", () => {
  let now = NOW;
  const u = usage(roots(), () => now);
  assert.deepEqual(u.meters().map((m) => [m.id, m.label, m.window, m.usedPercent]), [
    ["claude.five_hour", "Claude 5-hour", "five_hour", null],
    ["claude.week", "Claude week", "week", null],
    ["codex.week", "Codex week", "week", null],
  ], "the three meters are always there, empty until something reports");

  assert.equal(u.record("claude", [{ window: "five_hour", usedPercent: 42.44, resetsAt: Math.floor(NOW.getTime() / 1000) + 3600 }], "statusline"), true);
  assert.deepEqual(meter(u, "claude.five_hour"), { id: "claude.five_hour", label: "Claude 5-hour", window: "five_hour", usedPercent: 42.4, resetsAt: iso(new Date(NOW.getTime() + 3600_000)), asOf: iso(NOW), stale: false });

  assert.equal(u.record("claude", [{ window: "five_hour", usedPercent: 10, resetsAt: null }], "claude-code-cache", ago(60)), false, "an older reading is ignored");
  assert.equal(meter(u, "claude.five_hour").usedPercent, 42.4);
  assert.equal(u.record("claude", [{ window: "five_hour", usedPercent: 42.4, resetsAt: Math.floor(NOW.getTime() / 1000) + 3600 }], "statusline"), false, "the same reading changes nothing");

  now = new Date(NOW.getTime() + 31 * 60_000);
  assert.equal(meter(u, "claude.five_hour").stale, true);
  assert.equal(meter(u, "claude.five_hour").usedPercent, 42.4, "a stale reading is still shown, with its age");
});

test("a window that reset since its reading shows empty and stale; the week keeps its weekday, a 5-hour window has no known end", () => {
  const u = usage(roots());
  u.record("claude", [
    { window: "five_hour", usedPercent: 57, resetsAt: "2026-09-20T12:40:00Z" },
    { window: "week", usedPercent: 56, resetsAt: "2026-09-26T06:00:00Z" },
  ], "claude-code-cache", new Date("2026-09-20T10:58:34Z"));
  assert.deepEqual(meter(u, "claude.week"), { id: "claude.week", label: "Claude week", window: "week", usedPercent: 0, resetsAt: "2026-10-03T06:00:00.000Z", asOf: "2026-09-20T10:58:34.000Z", stale: true });
  assert.deepEqual([meter(u, "claude.five_hour").usedPercent, meter(u, "claude.five_hour").resetsAt, meter(u, "claude.five_hour").stale], [0, null, true]);
});

test("Claude Code's cached /usage read is the fallback, shown with its age; the newest Codex rollout's limits are read too", () => {
  const r = roots();
  writeFileSync(r.claudeJson, JSON.stringify({
    oauthAccount: { emailAddress: "never@read.example" },
    cachedUsageUtilization: { fetchedAtMs: ago(10).getTime(), utilization: { five_hour: { utilization: 57, resets_at: iso(new Date(NOW.getTime() + 3600_000)) }, seven_day: { utilization: 56, resets_at: "2026-10-03T06:00:00Z" } } },
  }));
  const day = join(r.codex, "2026", "09", "29");
  mkdirSync(day, { recursive: true });
  const limits = (used: number) => ({ limit_id: "codex", primary: { used_percent: used, window_minutes: 10080, resets_at: 1791046697 }, secondary: null, plan_type: "pro" });
  writeFileSync(join(day, "rollout-2026-09-29T20-36-37-01a0ee74-5a58-7122-907e-f27f0a724531.jsonl"), lines(
    { timestamp: "2026-09-29T19:00:00Z", type: "session_meta", payload: { cwd: "/w/a" } },
    { timestamp: "2026-09-29T19:01:00Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits(38) } },
    { timestamp: "2026-09-29T19:02:20Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits(39) } },
  ));
  const u = usage(r);
  const claude = meter(u, "claude.five_hour");
  assert.deepEqual([claude.usedPercent, claude.asOf, claude.stale], [57, iso(ago(10)), false]);
  assert.equal(meter(u, "claude.week").usedPercent, 56);
  const codex = meter(u, "codex.week");
  assert.deepEqual([codex.usedPercent, codex.resetsAt, codex.asOf], [39, "2026-10-03T16:58:17.000Z", "2026-09-29T19:02:20.000Z"]);
  assert.ok(!JSON.stringify(u.meters()).includes("never@read"), "nothing else in Claude Code's file is taken");

  u.record("claude", [{ window: "five_hour", usedPercent: 61 }], "statusline");
  assert.equal(meter(u, "claude.five_hour").usedPercent, 61, "the statusline is newer than the cache, so it wins");
});

test("Codex's x-codex-* headers become readings by window; a reply without them gives none", () => {
  assert.deepEqual(codexHeaderReadings({
    "X-Codex-Primary-Used-Percent": "39.5", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": "1791046697",
    "x-codex-secondary-used-percent": "12", "x-codex-secondary-window-minutes": "300", "x-codex-secondary-reset-after-seconds": "600",
  }, NOW.getTime()), [
    { usedPercent: 39.5, windowMinutes: 10080, resetsAt: "1791046697" },
    { usedPercent: 12, windowMinutes: 300, resetsAt: iso(new Date(NOW.getTime() + 600_000)) },
  ]);
  assert.deepEqual(codexHeaderReadings({ "content-type": "text/event-stream" }), []);
  const u = usage(roots());
  u.record("codex", codexHeaderReadings({ "x-codex-primary-used-percent": "39.5", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": "1791046697" }), "pi-headers");
  assert.deepEqual([meter(u, "codex.week").usedPercent, meter(u, "codex.week").resetsAt], [39.5, "2026-10-03T16:58:17.000Z"]);
  u.record("codex", [{ windowMinutes: 300, usedPercent: 5 }], "pi-headers");
  assert.ok(u.meters().some((m) => m.id === "codex.five_hour" && m.label === "Codex 5-hour"), "a Codex 5-hour meter appears once a plan reports one");
});

/** One session of each kind, this week, with the duplicates each harness writes. */
function sessions(r: UsageRoots) {
  const at = iso(ago(60));
  const claudeReply = (id: string, cwd: string, out: number) => ({ type: "assistant", sessionId: "s1", cwd, timestamp: at, requestId: `req_${id}`, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: out } } });
  mkdirSync(join(r.claude, "-w-a", "s1", "subagents"), { recursive: true });
  // A streamed reply is written once per content block, each with the same usage: counted once.
  writeFileSync(join(r.claude, "-w-a", "s1.jsonl"), lines({ type: "user", cwd: "/w/a", timestamp: at }, claudeReply("m1", "/w/a", 50), claudeReply("m1", "/w/a", 50), claudeReply("m2", "/w/a", 40)));
  writeFileSync(join(r.claude, "-w-a", "s1", "subagents", "agent-x.jsonl"), lines(claudeReply("m3", "/w/a", 10)));
  // Last week's reply is outside the window.
  writeFileSync(join(r.claude, "-w-a", "old.jsonl"), lines({ ...claudeReply("m9", "/w/a", 999), sessionId: "old", timestamp: "2026-09-20T12:00:00Z" }));
  mkdirSync(join(r.pi, "--w-b--"), { recursive: true });
  const pi = join(r.pi, "--w-b--", "2026-10-02_x.jsonl");
  const piReply = (provider: string, out: number) => ({ type: "message", timestamp: at, message: { role: "assistant", provider, model: "gpt-6-astra", timestamp: ago(60).getTime(), usage: { input: 20, output: out, cacheRead: 500, cacheWrite: 0 } } });
  writeFileSync(pi, lines({ type: "session", id: "header-id", cwd: "/w/b/app", timestamp: at }, piReply("openai-codex", 100), piReply("anthropic", 30), piReply("somebody-else", 1000)));
  const day = join(r.codex, "2026", "10", "02");
  mkdirSync(day, { recursive: true });
  const count = (total: number, input: number, cached: number, out: number) => ({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: out } } } });
  writeFileSync(join(day, "rollout-2026-10-02T10-00-00-01a0ee74-5a58-7122-907e-f27f0a724531.jsonl"), lines(
    { timestamp: at, type: "session_meta", payload: { cwd: "/w/c" } },
    count(1000, 900, 800, 100), count(1000, 900, 800, 100), count(1300, 250, 200, 50),
  ));
  return { pi };
}

const team = (id: string, path: string, worktrees: string[] = []): Team => ({ id, name: id, purpose: "", handsTo: null, path, branch: null, standing: false, worktrees, createdAt: "" });

test("tokens per agent and team come from the three kinds of session file, counted once, within the week", () => {
  const r = roots();
  const { pi } = sessions(r);
  const u = usage(r);
  u.record("claude", [{ window: "week", usedPercent: 50, resetsAt: "2026-10-03T06:00:00Z" }], "statusline");
  u.record("codex", [{ window: "week", usedPercent: 40, resetsAt: "2026-10-03T16:58:17Z" }], "pi-headers");
  while (u.scan(64)) {} // a slice at a time, as the background does
  const view = u.view([
    { id: "lead", harness: "claude", cwd: "/w/a", sessionId: "s1", teamId: "a" },
    { id: "piper", harness: "pi", cwd: "/w/b/app", sessionId: pi, teamId: null },
    { id: "cody", harness: "codex", cwd: "/w/c", sessionId: null, teamId: "c" },
  ], [team("a", "/w/a"), team("b", "/w/b"), team("c", "/w/elsewhere", ["/w/c"])]);

  // Claude: m1 once, m2, and the sub-agent's m3 (input + cache writes + output; cache reads left out).
  assert.equal(view.agents.lead!.tokens, 3 * 110 + 50 + 40 + 10);
  // Pi: the Codex reply and the Claude one; a provider with no plan here is left out.
  assert.equal(view.agents.piper!.tokens, (20 + 100) + (20 + 30));
  // Codex: the repeated count once; input less what was cached, plus output.
  assert.equal(view.agents.cody!.tokens, (100 + 100) + (50 + 50), "found as the one Codex agent in that folder");
  assert.equal(view.teams.b!.tokens, view.agents.piper!.tokens, "a session's folder inside a worktree puts it on that team");
  assert.equal(view.teams.c!.tokens, view.agents.cody!.tokens, "a team's other worktree counts too");

  // Shares: each provider's weekly meter split by weighted tokens; Pi's Claude reply is part of Claude's.
  const { lead, piper, cody } = view.agents;
  assert.ok(Math.abs(lead!.share! + piper!.share! + cody!.share! - 90) < 0.3, "all of both meters is accounted for");
  // Weights (input + 1.25 cache writes + 0.1 cache reads + 5 output). Claude: the lead 485 + 435 + 285, Pi's reply 220.
  // Codex: Pi's reply 570, the rollout 680 + 320.
  assert.equal(lead!.share, 42.3, "1205 / 1425 of Claude's 50");
  assert.equal(piper!.share, 22.2, "570 / 1570 of Codex's 40, plus 220 / 1425 of Claude's 50");
  assert.equal(cody!.share, 25.5, "1000 / 1570 of Codex's 40");
  // The share is split by the weekly meter that scaled it, so the UI can name each week.
  assert.deepEqual(lead!.parts, [{ meter: "claude.week", share: 42.3 }]);
  assert.deepEqual(piper!.parts, [{ meter: "codex.week", share: 14.5 }, { meter: "claude.week", share: 7.7 }]);
});

test("with no weekly reading for its window there is nothing to scale by, so the share is unknown", () => {
  const r = roots();
  sessions(r);
  const u = usage(r);
  u.record("claude", [{ window: "week", usedPercent: 56, resetsAt: "2026-09-26T06:00:00Z" }], "claude-code-cache", new Date("2026-09-20T10:58:34Z"));
  u.scan();
  const view = u.view([{ id: "lead", harness: "claude", cwd: "/w/a", sessionId: "s1", teamId: "a" }], [team("a", "/w/a")]);
  assert.equal(view.agents.lead!.tokens, 430);
  assert.equal(view.agents.lead!.share, null, "last week's reading says nothing about this week");
});

test("a file read part-way is picked up where it stopped, and a line still being written waits", () => {
  const r = roots();
  mkdirSync(join(r.claude, "-w-a"), { recursive: true });
  const file = join(r.claude, "-w-a", "s1.jsonl");
  const reply = (id: string) => JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/w/a", timestamp: iso(ago(5)), requestId: id, message: { id, usage: { input_tokens: 1, output_tokens: 9 } } });
  writeFileSync(file, `${reply("a")}\n${reply("b").slice(0, 30)}`);
  let now = NOW;
  const u = usage(r, () => now);
  const tokens = () => u.view([{ id: "x", harness: "claude", cwd: "/w/a", sessionId: "s1", teamId: null }], []).agents.x?.tokens;
  u.scan();
  assert.equal(tokens(), 10);
  appendFileSync(file, `${reply("b").slice(30)}\n`);
  now = new Date(NOW.getTime() + 20_000);
  u.scan();
  assert.equal(tokens(), 20);
});

test("the founder's rule: Claude crew pause at 90% of the 5-hour reading, until it resets, and only then", () => {
  let now = NOW;
  const u = usage(roots(), () => now);
  assert.equal(u.claudePause(), null, "no reading never pauses anything");
  u.record("claude", [{ window: "five_hour", usedPercent: 89.9, resetsAt: iso(new Date(NOW.getTime() + 3600_000)) }], "statusline");
  assert.equal(u.claudePause(), null);
  u.record("claude", [{ window: "five_hour", usedPercent: 92, resetsAt: iso(new Date(NOW.getTime() + 3600_000)) }], "statusline");
  assert.deepEqual(u.claudePause(), { percent: 92, resetsAt: iso(new Date(NOW.getTime() + 3600_000)) });
  assert.match(u.crewPause()!.why, /^the founder's 5-hour Claude use is 92%, until \d\d:\d\d when its window starts again$/);
  now = new Date(NOW.getTime() + 31 * 60_000);
  assert.equal(meter(u, "claude.five_hour").stale, true);
  assert.equal(u.claudePause()!.percent, 92, "a high reading holds with age, until its window resets");
  now = new Date(NOW.getTime() + 61 * 60_000);
  assert.equal(u.claudePause(), null, "the window has reset");

  // With no known end to hold until, a reading is trusted only while fresh.
  now = NOW;
  const v = usage(roots(), () => now);
  v.record("claude", [{ window: "five_hour", usedPercent: 95 }], "statusline");
  assert.equal(v.claudePause()!.percent, 95);
  now = new Date(NOW.getTime() + 31 * 60_000);
  assert.equal(v.claudePause(), null);
});

test("near the limit the crew guide gives the Pi backups under Mix, and changes nothing on Claude Code only or Pi only", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-crew-"));
  const crew = new CrewTreeStore(dir, { piStore: join(dir, "none.json") });
  crew.seed();
  const tree = structuredClone(crew.state().tree) as CrewTree;
  const plain = crew.text();
  assert.equal(crew.lead().harness, "claude");

  crew.pause = () => ({ harness: "claude", why: "the founder's 5-hour Claude use is 92%, until 17:40" });
  const paused = crew.text();
  assert.match(paused, /^The founder's switch: mixed, but the office has paused Claude Code for now: the founder's 5-hour Claude use is 92%, until 17:40\. Every choice below already runs on Pi/m);
  assert.ok(!/--kind claude/.test(paused), "no Claude Code start line is offered");
  assert.equal((paused.match(/--kind pi/g) ?? []).length, (plain.match(/Start: /g) ?? []).length, "every rule gives its Pi backup");
  assert.equal(crew.lead().harness, "pi", "a new project's lead too");
  assert.equal(crew.state().tree.mode, "mixed", "the founder's setting is never changed");

  crew.save({ ...tree, mode: "claude" });
  assert.ok(!/--kind pi/.test(crew.text()), "Claude Code only never moves to Pi");
  assert.doesNotMatch(crew.text(), /paused/);
  assert.equal(crew.lead().harness, "claude");
  crew.save({ ...tree, mode: "pi" });
  assert.ok(!/--kind claude/.test(crew.text()));
  assert.doesNotMatch(crew.text(), /paused/);
});

test("a harness posts its limits to the service, which says a change and refuses a malformed report", async () => {
  const db = openDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "usage-http-"));
  const u = new Usage(db, () => NOW, roots());
  const port = 49_000 + Math.floor(Math.random() * 900);
  const server = createInboxServer(new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null }), null, { port, staticDir: null, usage: u });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  let said = 0;
  const told = u.onChange;
  u.onChange = () => (said++, told());
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/agent/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const ok = await post({ provider: "claude", limits: [{ window: "five_hour", usedPercent: 42, resetsAt: 1791000000 }, { window: "week", usedPercent: 61, resetsAt: 1791050000 }] });
    assert.deepEqual(await ok.json(), { changed: true });
    assert.equal(meter(u, "claude.week").usedPercent, 61);
    assert.equal(said, 1, "a change is said once, so the office redraws");
    assert.equal((await post({ provider: "gemini", limits: [] })).status, 400);
    assert.equal((await post({ provider: "codex", limits: "39%" })).status, 400);
  } finally {
    server.close();
  }
});

test("when Claude's 5-hour window and Codex are both near their limits, the guide keeps Claude and the founder is told once per pause", () => {
  const db = openDatabase(":memory:");
  let now = NOW;
  const u = new Usage(db, () => now, roots());
  const notices = new OfficeNotices(db);
  const told = () => db.prepare("SELECT text FROM messages WHERE to_founder = 1 AND from_office = 1").all() as Array<{ text: string }>;
  const hour = (n: number) => iso(new Date(NOW.getTime() + n * 3600_000));

  u.record("codex", [{ window: "week", usedPercent: 94, resetsAt: "2026-10-03T16:58:17Z" }], "codex-rollout", ago(120));
  assert.equal(u.tellFounder(notices, true), false, "Claude is not paused: nothing to say");
  u.record("claude", [{ window: "five_hour", usedPercent: 92, resetsAt: hour(2) }], "statusline");
  u.record("codex", [{ window: "week", usedPercent: 85, resetsAt: "2026-10-03T16:58:17Z" }], "pi-headers", ago(1));
  assert.equal(u.tellFounder(notices, true), false, "Codex has room: nothing to say");

  u.record("codex", [{ window: "week", usedPercent: 94, resetsAt: "2026-10-03T16:58:17Z" }], "pi-headers");
  assert.equal(u.tellFounder(notices, true), true);
  assert.match(told()[0]!.text, /^Your 5-hour Claude use is 92% \(until \d\d:\d\d\) and Codex's week is at 94% \(it resets \w+ \d\d:\d\d\)\. The crew guide keeps Claude Code, which starts again sooner, so new crew may stop at its limit soon\.$/);
  assert.equal(u.tellFounder(notices, true), false, "once per pause");
  assert.equal(u.tellFounder(notices, false), false, "only under Mix");
  assert.equal(told().length, 1);

  // The next 5-hour window pauses again later: that is a new pause, told again.
  now = new Date(NOW.getTime() + 3 * 3600_000);
  u.record("claude", [{ window: "five_hour", usedPercent: 95, resetsAt: hour(7) }], "statusline");
  u.record("codex", [{ window: "week", usedPercent: 97, resetsAt: "2026-10-03T16:58:17Z" }], "pi-headers");
  assert.equal(u.tellFounder(notices, true), true);
  assert.equal(told().length, 2);
});

test("Codex's windows are told by their length, whichever of primary and secondary carries them, from headers and from a rollout", () => {
  const u = usage(roots());
  u.record("codex", codexHeaderReadings({
    "x-codex-primary-used-percent": "30", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "3600",
    "x-codex-secondary-used-percent": "60", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": "1791046697",
  }, NOW.getTime()), "pi-headers");
  assert.deepEqual(u.meters().map((m) => [m.id, m.label, m.usedPercent]), [
    ["claude.five_hour", "Claude 5-hour", null], ["claude.week", "Claude week", null], ["codex.week", "Codex week", 60], ["codex.five_hour", "Codex 5-hour", 30],
  ]);
  assert.equal(meter(u, "codex.five_hour").resetsAt, iso(new Date(NOW.getTime() + 3600_000)));

  // A rollout the way a plan with both windows writes it, the week first this time.
  const r = roots();
  const day = join(r.codex, "2026", "10", "02");
  mkdirSync(day, { recursive: true });
  const window = (used: number, minutes: number, resets: number) => ({ used_percent: used, window_minutes: minutes, resets_at: resets });
  writeFileSync(join(day, "rollout-2026-10-02T10-00-00-01a0ee74-5a58-7122-907e-f27f0a724531.jsonl"), lines(
    { timestamp: iso(ago(5)), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: window(71, 10080, 1791046697), secondary: window(44, 300, Math.floor(NOW.getTime() / 1000) + 7200) } } },
  ));
  const v = usage(r);
  assert.deepEqual([meter(v, "codex.week").usedPercent, meter(v, "codex.week").resetsAt], [71, "2026-10-03T16:58:17.000Z"]);
  assert.deepEqual([meter(v, "codex.five_hour").usedPercent, meter(v, "codex.five_hour").resetsAt], [44, iso(new Date(NOW.getTime() + 7200_000))]);
});

test("the mirror rule: a Codex meter at 90% or more pauses Pi until it resets, whatever its age; both high keeps Claude", () => {
  let now = NOW;
  const u = usage(roots(), () => now);
  const hour = (n: number) => iso(new Date(NOW.getTime() + n * 3600_000));
  assert.equal(u.codexPause(), null, "no reading pauses nothing");
  u.record("codex", [{ window: "week", usedPercent: 89.9, resetsAt: hour(30) }], "pi-headers");
  assert.equal(u.codexPause(), null);
  assert.equal(u.crewPause(), null);

  u.record("codex", [{ window: "week", usedPercent: 91, resetsAt: hour(30) }], "pi-headers");
  assert.equal(u.codexPause()!.percent, 91);
  assert.match(u.crewPause()!.why, /^the founder's weekly Codex use is 91%, until \w+ \d\d:\d\d when its window starts again$/);
  assert.equal(u.crewPause()!.harness, "pi");

  now = new Date(NOW.getTime() + 20 * 3600_000);
  assert.equal(meter(u, "codex.week").stale, true);
  assert.equal(u.crewPause()!.harness, "pi", "a high reading holds with age, until its window resets");
  now = new Date(NOW.getTime() + 31 * 3600_000);
  assert.equal(u.codexPause(), null, "the window has reset");
  assert.equal(u.crewPause(), null);

  now = NOW;
  const v = usage(roots(), () => now);
  v.record("codex", [{ window: "week", usedPercent: 40, resetsAt: hour(30) }, { window: "five_hour", usedPercent: 93, resetsAt: hour(2) }], "codex-rollout");
  assert.match(v.crewPause()!.why, /^the founder's 5-hour Codex use is 93%, until \d\d:\d\d when its window starts again$/, "the 5-hour window alone pauses Pi");

  v.record("claude", [{ window: "five_hour", usedPercent: 95, resetsAt: hour(3) }], "statusline");
  assert.equal(v.claudePause()!.percent, 95);
  assert.equal(v.crewPause()!.harness, "pi", "both high: Pi is paused and Claude kept");
  v.record("codex", [{ window: "five_hour", usedPercent: 10, resetsAt: hour(2) }], "pi-headers");
  assert.equal(v.crewPause()!.harness, "claude", "only Claude high: the Claude pause as before");
});

test("near Codex's limit the crew guide gives the Claude backups under Mix, and changes nothing on Claude Code only or Pi only", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-crew-"));
  const crew = new CrewTreeStore(dir, { piStore: join(dir, "none.json") });
  crew.seed();
  const tree = structuredClone(crew.state().tree) as CrewTree;
  const astra = { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "high" };
  tree.rules[0]!.use = astra;
  tree.rules[0]!.backup = { harness: "claude", model: "opus", effort: "high" };
  tree.fallback = { ...tree.fallback, ...astra, backup: { harness: "claude", model: "sonnet", effort: "high" } };
  tree.lead = { ...tree.lead, use: astra, backup: { harness: "claude", model: "opus", effort: "medium" } };
  crew.save(tree);
  const plain = crew.text();
  assert.match(plain, /--kind pi/);
  assert.equal(crew.lead().harness, "pi");

  crew.pause = () => ({ harness: "pi", why: "the founder's weekly Codex use is 94%, until Sat 16:58 when its window starts again" });
  const paused = crew.text();
  assert.match(paused, /^The founder's switch: mixed, but the office has paused Pi for now: the founder's weekly Codex use is 94%, until Sat 16:58 when its window starts again\. Every choice below already runs on Claude Code/m);
  assert.ok(!/--kind pi/.test(paused), "no Pi start line is offered");
  assert.equal((paused.match(/--kind claude/g) ?? []).length, (plain.match(/Start: /g) ?? []).length, "every rule gives its Claude backup");
  assert.equal(crew.lead().harness, "claude", "a new project's lead too");
  assert.equal(crew.state().tree.mode, "mixed", "the founder's setting is never changed");

  crew.save({ ...tree, mode: "claude" });
  assert.ok(!/--kind pi/.test(crew.text()));
  assert.doesNotMatch(crew.text(), /paused/);
  crew.save({ ...tree, mode: "pi" });
  assert.ok(!/--kind claude/.test(crew.text()), "Pi only never moves to Claude Code");
  assert.doesNotMatch(crew.text(), /paused/);
  assert.equal(crew.lead().harness, "pi");
});

/** An auth.json as the codex CLI keeps it, with an access token that expires at `exp`. */
function codexLogin(exp: number, accountId: string | null = "acct-1"): string {
  const jwt = ["h", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "s"].join(".");
  const path = join(mkdtempSync(join(tmpdir(), "codex-auth-")), "auth.json");
  const before = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt, refresh_token: "r", account_id: accountId } });
  writeFileSync(path, before);
  return path;
}
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const accountBody = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: nowSeconds + 3600 },
    secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: nowSeconds + 86400 },
  },
};
const replying = (status: number, body: unknown, seen: { url: string; headers: Record<string, string> }[] = []) => async (url: string, headers: Record<string, string>) => {
  seen.push({ url, headers });
  return { status, json: async () => body };
};

test("the Codex account's windows are told by their length and kept as Codex readings, a newer one winning over a rollout's", async () => {
  const u = usage(roots());
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const path = codexLogin(nowSeconds + 3600);
  const before = readFileSync(path, "utf8");
  u.codexAccount = { authPath: path, fetcher: replying(200, accountBody, seen) };
  assert.equal(u.record("codex", [{ windowMinutes: 10080, usedPercent: 40, resetsAt: nowSeconds + 86400 }], "codex-rollout", ago(20)), true);

  assert.equal(await u.readAccount(), true);
  assert.deepEqual(seen.map((s) => s.url), ["https://chatgpt.com/backend-api/wham/usage"], "one call, to the one host");
  assert.match(seen[0]!.headers.Authorization!, /^Bearer /);
  assert.equal(seen[0]!.headers["ChatGPT-Account-Id"], "acct-1");
  assert.deepEqual(meter(u, "codex.week"), { id: "codex.week", label: "Codex week", window: "week", usedPercent: 61, resetsAt: iso(new Date((nowSeconds + 86400) * 1000)), asOf: iso(NOW), stale: false });
  assert.equal(meter(u, "codex.five_hour").usedPercent, 12.5);
  assert.equal(readFileSync(path, "utf8"), before, "auth.json is only read");

  assert.equal(u.record("codex", [{ windowMinutes: 10080, usedPercent: 40 }], "codex-rollout", ago(1)), false, "a reading older than the account's is ignored");
  assert.equal(meter(u, "codex.week").usedPercent, 61);
});

test("the Codex account is skipped quietly with no login, an expired or refused token, a failed call or an odd reply", async () => {
  const u = usage(roots());
  const calls: unknown[] = [];
  const count = (status: number, body: unknown = accountBody) => async () => { calls.push(1); return { status, json: async () => body }; };

  u.codexAccount = { authPath: join(tmpdir(), "no-such-dir", "auth.json"), fetcher: count(200) };
  assert.equal(await u.readAccount(), false, "no auth.json");
  u.codexAccount = { authPath: codexLogin(nowSeconds - 60), fetcher: count(200) };
  assert.equal(await u.readAccount(), false, "an expired token is not sent anywhere");
  assert.equal(calls.length, 0);

  const live = codexLogin(nowSeconds + 3600);
  for (const fetcher of [count(401), count(403), count(500), count(200, { rate_limit: null }), count(200, "nonsense"), async () => { throw new Error("offline"); }]) {
    u.codexAccount = { authPath: live, fetcher };
    assert.equal(await u.readAccount(), false);
  }
  assert.equal(meter(u, "codex.week").usedPercent, null, "nothing was recorded; the meter simply goes stale");
});
