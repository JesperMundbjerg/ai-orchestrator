import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { parseAdapter } from "../src/server/adapter.ts";
import { LaneRouting, piPaused, routingFiles } from "../src/server/lanerouting.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const OVERRIDE = "<git-common-dir>/fysiklab/lane-routing.json";
const TRACKED = {
  runtimes: { "mission-control": "claude", einstein: "claude", galilei: "pi" },
  lanes: { "mission-control": "claude-code/opus", einstein: "claude-code/sonnet", galilei: "openai-codex/gpt-6-astra", heisenberg: "openai-codex/gpt-6.1-sol" },
  agents: { "*": "openai-codex/gpt-5.6-sol" },
};

/** A FysikLab-like main checkout in a temp git repo; `declare` adds the laneRouting declaration. */
function project(declare = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lanerouting-")));
  execFileSync("git", ["init", "-q", root]);
  const adapter = {
    project: "fysiklab",
    lanes: [{ name: "mission-control", worktree: ".", agent: "dispatch-mission-control", role: "router" }, { name: "einstein", agent: "einstein" }, { name: "galilei", agent: "galilei" }, { name: "heisenberg", agent: "heisenberg" }],
    ...(declare ? { laneRouting: { override: OVERRIDE, tracked: ".pi/fysiklab.json" } } : {}),
  };
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify(adapter));
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi/fysiklab.json"), JSON.stringify(TRACKED));
  const state: WorldState = {
    repositories: [{ name: "space-shuttle", root, base: "dev", adapter: parseAdapter(readFileSync(join(root, "orchestrator.json"), "utf8"), root, "space-shuttle").adapter, adapterProblems: [] }],
    agents: [
      { id: "a-einstein", name: "Einstein", identity: "claude:/x@einstein", cwd: root, status: "idle", sessionName: null },
      { id: "a-galilei", name: "Galilei", identity: "pi:/x@galilei", cwd: root, status: "idle", sessionName: null },
    ] as unknown as WorldAgent[],
    teams: [],
  } as unknown as WorldState;
  const file = join(root, ".git/fysiklab/lane-routing.json");
  return { root, state, file, read: () => JSON.parse(readFileSync(file, "utf8")), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function routing(dbFile = ":memory:") {
  const db = openDatabase(dbFile);
  const notices: Array<{ title: string; body: string; agentIds: string[] }> = [];
  const lr = new LaneRouting(db, { notice: (title, body, agentIds) => void notices.push({ title, body, agentIds }) });
  return { db, lr, notices };
}

test("without the declaration the office writes nothing, whatever happens", () => {
  const p = project(false);
  const { lr, notices } = routing();
  lr.switched(p.state, "a-einstein", "pi", "openai-codex/gpt-6-astra");
  lr.sync(p.state, true);
  lr.sync(p.state, false);
  assert.equal(existsSync(join(p.root, ".git/fysiklab")), false);
  assert.deepEqual(notices, []);
  p.cleanup();
});

test("<git-common-dir> is git's common directory of the main checkout, and an override outside it or the checkout is refused", () => {
  const p = project();
  assert.equal(routingFiles(p.root, "fysiklab")!.override, p.file);
  // The adapter knows the key: a declaring project shows no problem for it.
  assert.deepEqual(parseAdapter(readFileSync(join(p.root, "orchestrator.json"), "utf8"), p.root, "space-shuttle").problems, []);
  writeFileSync(join(p.root, "orchestrator.json"), JSON.stringify({ project: "fysiklab", laneRouting: { override: "../elsewhere.json" } }));
  assert.throws(() => routingFiles(p.root, "fysiklab"), /outside the main checkout/);
  writeFileSync(join(p.root, "orchestrator.json"), JSON.stringify({ project: "fysiklab", laneRouting: { override: 3 } }));
  assert.throws(() => routingFiles(p.root, "fysiklab"), /laneRouting must be/);
  p.cleanup();
});

test("a switch writes the lane's runtime and model together, in one rename, and keeps every other key", () => {
  const p = project();
  mkdirSync(join(p.root, ".git/fysiklab"));
  writeFileSync(p.file, JSON.stringify({ runtimes: { galilei: "claude" }, lanes: { galilei: "claude-code/opus" }, agents: { "*": "x/y" }, futureKey: { keep: true } }));
  const { lr, notices } = routing();
  lr.switched(p.state, "a-einstein", "pi", "openai-codex/gpt-6-astra");
  assert.deepEqual(p.read(), {
    runtimes: { galilei: "claude", einstein: "pi" },
    lanes: { galilei: "claude-code/opus", einstein: "openai-codex/gpt-6-astra" },
    agents: { "*": "x/y" },
    futureKey: { keep: true },
  });
  lr.switched(p.state, "a-einstein", "claude", "sonnet");
  assert.equal(p.read().runtimes.einstein, "claude");
  assert.equal(p.read().lanes.einstein, "claude-code/sonnet");
  // Nothing half-written is left beside it.
  assert.deepEqual(readdirSync(join(p.root, ".git/fysiklab")), ["lane-routing.json"]);
  assert.equal(notices.length, 2);
  assert.match(notices[1]!.body, /einstein lane will start on Claude Code \(claude-code\/sonnet\).*not restarted.*next start/);
  assert.deepEqual(notices[1]!.agentIds, ["a-einstein"]);
  // Nothing about the tracked default was copied in: heisenberg and mission-control are not in the override.
  assert.equal(p.read().lanes.heisenberg, undefined);
  p.cleanup();
});

test("a Pi pause routes Pi lanes to Claude Code, and lifting it restores earlier values and deletes keys that were absent", () => {
  const p = project();
  mkdirSync(join(p.root, ".git/fysiklab"));
  // galilei is Pi by the tracked default; heisenberg by its override; einstein's override is Claude.
  const before = { runtimes: { heisenberg: "pi", einstein: "claude" }, lanes: { einstein: "claude-code/opus" }, other: 1 };
  writeFileSync(p.file, JSON.stringify(before));
  const { lr, notices } = routing();
  lr.sync(p.state, true);
  assert.deepEqual(p.read(), {
    runtimes: { heisenberg: "claude", einstein: "claude", galilei: "claude" },
    lanes: { einstein: "claude-code/opus", galilei: "claude-code/opus", heisenberg: "claude-code/sonnet" },
    other: 1,
  });
  assert.match(notices[0]!.body, /galilei \(claude-code\/opus\) and heisenberg \(claude-code\/sonnet\).*next start/);
  // Still paused: nothing is written again.
  lr.sync(p.state, true);
  assert.equal(notices.length, 1);
  lr.sync(p.state, false);
  assert.deepEqual(p.read(), before);
  assert.match(notices[1]!.body, /galilei and heisenberg are routed as before the pause/);
  p.cleanup();
});

test("a restart mid-pause still lifts it from what the database kept", () => {
  const p = project();
  const dbDir = mkdtempSync(join(tmpdir(), "lanerouting-db-"));
  const first = routing(join(dbDir, "inbox.sqlite"));
  first.lr.sync(p.state, true);
  assert.equal(p.read().runtimes.galilei, "claude");
  first.db.close();
  const second = routing(join(dbDir, "inbox.sqlite"));
  second.lr.sync(p.state, false);
  // The override had no keys before the pause: they are deleted, never filled with the tracked default.
  assert.deepEqual(p.read(), {});
  rmSync(dbDir, { recursive: true, force: true });
  p.cleanup();
});

test("a lane the founder switches by hand during a pause keeps that choice when the pause lifts", () => {
  const p = project();
  const { lr, notices } = routing();
  lr.sync(p.state, true);
  lr.switched(p.state, "a-galilei", "pi", "openai-codex/gpt-6.1-sol");
  // Someone else edits heisenberg during the pause too.
  const edited = p.read();
  edited.lanes.heisenberg = "claude-code/opus";
  writeFileSync(p.file, JSON.stringify(edited));
  lr.sync(p.state, false);
  assert.deepEqual(p.read(), { runtimes: { galilei: "pi", heisenberg: "claude" }, lanes: { galilei: "openai-codex/gpt-6.1-sol", heisenberg: "claude-code/opus" } });
  assert.match(notices.at(-1)!.body, /heisenberg was changed during the pause, so it keeps what it says now/);
  p.cleanup();
});

test("an override that cannot be read is never overwritten: the write is refused and the founder told once", () => {
  const p = project();
  mkdirSync(join(p.root, ".git/fysiklab"));
  writeFileSync(p.file, "{ half written");
  const { lr, notices } = routing();
  lr.switched(p.state, "a-einstein", "pi", "openai-codex/gpt-6-astra");
  lr.sync(p.state, true);
  lr.sync(p.state, true);
  assert.equal(readFileSync(p.file, "utf8"), "{ half written");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.body, /not valid JSON, so it was not changed/);
  // Once it is fixed, the pause applies.
  writeFileSync(p.file, "{}");
  lr.sync(p.state, true);
  assert.equal(p.read().runtimes.galilei, "claude");
  p.cleanup();
});

test("the pause is the crew guide's: Pi paused under Mix, not on credits, and never on a one-harness setting", () => {
  assert.equal(piPaused("mixed", { harness: "pi", why: "" }), true);
  assert.equal(piPaused("mixed", { harness: "pi", why: "", onCredits: true }), false);
  assert.equal(piPaused("mixed", { harness: "claude", why: "" }), false);
  assert.equal(piPaused("pi", { harness: "pi", why: "" }), false);
  assert.equal(piPaused("mixed", null), false);
});

test("an existing database gains the pause tables without losing anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanerouting-migrate-"));
  const file = join(dir, "inbox.sqlite");
  const old = openDatabase(file);
  const version = Number(old.prepare("PRAGMA user_version").get()!.user_version);
  // 14 is the schema version before lane routing's migration, so reopening reruns it (and any later ones).
  old.exec("DROP TABLE lane_routing_paused; DROP TABLE lane_routing_pauses; PRAGMA user_version = 14;");
  old.prepare("INSERT INTO usage_told (key, at) VALUES ('kept', 'now')").run();
  old.close();
  const db = openDatabase(file);
  assert.equal(Number(db.prepare("PRAGMA user_version").get()!.user_version), version);
  assert.equal(db.prepare("SELECT count(*) AS n FROM lane_routing_paused").get()!.n, 0);
  assert.equal(db.prepare("SELECT key FROM usage_told").get()!.key, "kept");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
