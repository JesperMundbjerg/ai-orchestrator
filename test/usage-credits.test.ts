import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import type { CrewTree } from "../src/shared/crewtree.ts";
import { codexHeaderReadings, creditsLeft } from "../src/shared/usage.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { OfficeNotices } from "../src/server/notices.ts";
import { Usage, type UsageRoots } from "../src/server/usage.ts";

const NOW = new Date("2026-10-02T15:00:00Z");
const WEEK_RESET = Math.floor(NOW.getTime() / 1000) + 2 * 86400;

/** A port nothing listens on now (the service checks requests against its own port). */
const freePort = () => new Promise<number>((done) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => done(port));
  });
});

function roots(): UsageRoots {
  const dir = mkdtempSync(join(tmpdir(), "usage-credits-"));
  const r = { claude: join(dir, "claude"), codex: join(dir, "codex"), pi: join(dir, "pi"), claudeJson: join(dir, "claude.json") };
  for (const d of [r.claude, r.codex, r.pi]) mkdirSync(d, { recursive: true });
  return r;
}
const usage = (r = roots(), now = () => NOW) => new Usage(openDatabase(":memory:"), now, r);
const credits = (u: Usage) => u.meters().find((m) => m.id === "codex.week")!.credits!;
const week = (used: number, c?: { hasCredits: boolean | null; unlimited: boolean | null; balance: number | null }) =>
  [{ usedPercent: used, windowMinutes: 10080, resetsAt: WEEK_RESET, ...(c ? { credits: c } : {}) }];

/** A rollout as the codex CLI writes it (shape of a real one, numbers made up). */
function rollout(r: UsageRoots, c: Record<string, unknown> | null, used = 100) {
  const day = join(r.codex, "2026", "10", "02");
  mkdirSync(day, { recursive: true });
  const limits = { limit_id: "codex", limit_name: null, primary: { used_percent: used, window_minutes: 10080, resets_at: WEEK_RESET }, secondary: null, ...(c ? { credits: c } : {}), plan_type: "pro", rate_limit_reached_type: null };
  writeFileSync(join(day, "rollout-2026-10-02T14-00-00-01a0ee74-5a58-7122-907e-f27f0a724531.jsonl"),
    [{ timestamp: "2026-10-02T14:00:00Z", type: "session_meta", payload: { cwd: "/w/a" } },
      { timestamp: "2026-10-02T14:59:00Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("Codex's credits parse from a reply's x-codex-credits-* headers and ride on its readings", () => {
  const readings = codexHeaderReadings({
    "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": String(WEEK_RESET),
    "X-Codex-Credits-Has-Credits": "True", "x-codex-credits-unlimited": "false", "x-codex-credits-balance": "1240.5000000000",
  });
  assert.deepEqual(readings[0]!.credits, { hasCredits: true, unlimited: false, balance: 1240.5 });
  assert.equal(codexHeaderReadings({ "x-codex-primary-used-percent": "40" })[0]!.credits, undefined, "a reply that says nothing of credits gives none");
  assert.deepEqual(codexHeaderReadings({ "x-codex-credits-balance": "5" }), [], "credits alone are no limit reading");

  assert.equal(creditsLeft({ hasCredits: false, unlimited: false, balance: 12 }), true, "a positive balance is credits left");
  assert.equal(creditsLeft({ hasCredits: null, unlimited: true, balance: null }), true, "so are unlimited ones");
  assert.equal(creditsLeft({ hasCredits: false, unlimited: false, balance: 0 }), false);
  assert.equal(creditsLeft(null), null, "no data is unknown, not none");
});

test("the newest rollout's rate_limits.credits are read, and unknown credits show as unknown, never 0", () => {
  const blank = usage();
  assert.deepEqual(credits(blank), { label: "Codex credits", left: null, balance: null, unlimited: false, asOf: null, stale: false, inUse: false });

  const r = roots();
  rollout(r, { has_credits: true, unlimited: false, balance: "61461.2477720000" });
  const c = credits(usage(r));
  assert.deepEqual([c.left, c.balance, c.unlimited, c.asOf, c.inUse], [true, 61461.247772, false, "2026-10-02T14:59:00.000Z", true]);

  const old = roots();
  rollout(old, null);
  assert.equal(credits(usage(old)).left, null, "a rollout from before Codex wrote credits leaves them unknown");
});

test("at Codex's limit with credits left Pi is not paused: the guide keeps Codex crew and says it runs on credits", () => {
  const u = usage();
  u.record("codex", week(100, { hasCredits: true, unlimited: false, balance: 1240 }), "pi-headers");
  const pause = u.crewPause()!;
  assert.equal(pause.onCredits, true);
  assert.equal(pause.harness, "pi");
  assert.equal(pause.why, "the founder's weekly Codex use is 100%, so Codex runs on the founder's Codex credits (1,240 left)");

  const dir = mkdtempSync(join(tmpdir(), "usage-credits-crew-"));
  const crew = new CrewTreeStore(dir, { piStore: join(dir, "none.json") });
  crew.seed();
  const tree = structuredClone(crew.state().tree) as CrewTree;
  const astra = { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "high" };
  tree.fallback = { ...tree.fallback, ...astra, backup: { harness: "claude", model: "sonnet", effort: "high" } };
  tree.lead = { ...tree.lead, use: astra, backup: { harness: "claude", model: "opus", effort: "medium" } };
  crew.save(tree);
  crew.pause = () => u.crewPause();
  const text = crew.text();
  assert.match(text, /^The founder's switch: mixed\. Each rule's own choice applies: Pi stays available .*runs on the founder's Codex credits \(1,240 left\)\./m);
  assert.match(text, /--kind pi/, "Pi crew can still be started");
  assert.equal(crew.lead().harness, "pi");

  const notices = new OfficeNotices(openDatabase(":memory:"));
  const told = new Usage(openDatabase(":memory:"), () => NOW, roots());
  told.record("codex", week(100, { hasCredits: true, unlimited: false, balance: 1240 }), "pi-headers");
  assert.equal(told.tellFounder(notices, true), true, "the founder is told Codex runs on credits");
  assert.equal(told.tellFounder(notices, true), false, "once per Codex window");
});

test("at Codex's limit with no credits left Pi is paused as before; with Claude high too, credits move the pause to Claude", () => {
  const none = usage();
  none.record("codex", week(100, { hasCredits: false, unlimited: false, balance: 0 }), "pi-headers");
  assert.equal(none.crewPause()!.harness, "pi");
  assert.equal(none.crewPause()!.onCredits, undefined);
  assert.match(none.crewPause()!.why, /^the founder's weekly Codex use is 100% and no Codex credits are left, until \w+ \d\d:\d\d when its window starts again$/);

  const both = usage();
  both.record("claude", [{ window: "five_hour", usedPercent: 95, resetsAt: Math.floor(NOW.getTime() / 1000) + 3600 }], "statusline");
  both.record("codex", week(100, { hasCredits: true, unlimited: false, balance: 1240 }), "pi-headers");
  assert.equal(both.crewPause()!.harness, "claude", "Codex goes on with credits, so Claude's own limit pauses Claude Code");
  assert.match(both.crewPause()!.why, /Codex credits \(1,240 left\)$/);

  // The credits run out: a newer reading says so, and Pi is paused again.
  both.record("codex", week(100, { hasCredits: false, unlimited: false, balance: 0 }), "pi-headers", new Date(NOW.getTime() + 1000));
  assert.equal(both.crewPause()!.harness, "pi");
});

test("with no credit data the pause is today's: Pi stops at Codex's limit", () => {
  const u = usage();
  u.record("codex", week(95), "codex-account");
  assert.deepEqual(u.crewPause(), { harness: "pi", why: u.crewPause()!.why });
  assert.match(u.crewPause()!.why, /^the founder's weekly Codex use is 95%, until /);
  assert.equal(credits(u).left, null);
});

test("an older credit reading never replaces a newer one, and a harness posts credits with its limits", async () => {
  const u = usage();
  u.record("codex", week(100, { hasCredits: true, unlimited: false, balance: 900 }), "pi-headers");
  u.record("codex", week(100, { hasCredits: false, unlimited: false, balance: 0 }), "codex-rollout", new Date(NOW.getTime() - 3600_000));
  assert.equal(credits(u).balance, 900);

  const db = openDatabase(":memory:");
  const posted = new Usage(db, () => NOW, roots());
  const files = join(mkdtempSync(join(tmpdir(), "usage-credits-http-")), "files");
  const port = await freePort();
  const server = createInboxServer(new Inbox(db, files, { available: () => false, forSession: () => null, resolvePane: () => null }), null, { port, staticDir: null, usage: posted });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/agent/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post({ provider: "codex", limits: codexHeaderReadings({ "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "10080", "x-codex-credits-has-credits": "true", "x-codex-credits-balance": "75" }) });
    assert.equal(ok.status, 200);
    assert.deepEqual([credits(posted).left, credits(posted).balance], [true, 75]);
    const bad = await post({ provider: "codex", limits: [{ usedPercent: 1, credits: { hasCredits: "yes", unlimited: null, balance: null } }] });
    assert.equal(bad.status, 400, "malformed credits are refused");
  } finally {
    server.close();
  }
});
