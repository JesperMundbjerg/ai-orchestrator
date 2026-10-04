import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { Switches, type SwitchSource } from "../src/server/switch.ts";
import { LaneRouting } from "../src/server/lanerouting.ts";

test("the founder switching a standing lane's agent routes the lane to the new harness for its next start, and says so", async () => {
  // In a folder of its own: the office looks at the folders beside a repository.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "switch-lanerouting-")));
  const root = join(parent, "space-shuttle");
  const lane = join(parent, "space-shuttle-einstein");
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify({
    project: "fysiklab",
    lanes: [{ name: "einstein", worktree: "../space-shuttle-einstein" }],
    laneRouting: { override: "<git-common-dir>/fysiklab/lane-routing.json" },
  }));
  execFileSync("git", ["-C", root, "add", "orchestrator.json"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  execFileSync("git", ["-C", root, "worktree", "add", "-q", lane]);

  let live: LiveAgent[] = [{ paneId: "old1", harness: "claude", sessionId: "s-old1", cwd: lane, status: "idle", title: null, name: "einstein" }];
  const source: SwitchSource = {
    available: () => true,
    live: () => live,
    prompt: async (_pane, text) => {
      const file = text.match(/handoff for it now to (\S+\.md)/)?.[1];
      if (file) writeFileSync(file, "# Handoff\n");
    },
    notify: async () => {},
    createWorktree: async () => ({ paneId: "unused" }),
    startAgent: async (pane, name, harness) => void (live = [...live, { paneId: pane, harness, sessionId: `s-${pane}`, cwd: lane, status: "idle", title: null, name }]),
    closePane: async (pane) => void (live = live.filter((a) => a.paneId !== pane)),
    removeWorktree: async () => {},
    refresh: async () => {},
    openPane: async () => "new1",
    renameAgent: async (pane, name) => void (live = live.map((a) => (a.paneId === pane ? { ...a, name } : a))),
  };
  const dir = mkdtempSync(join(tmpdir(), "switch-lanerouting-data-"));
  const db = openDatabase(":memory:");
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(dir, "files"), presence);
  const world = new World(db, source, () => inbox.state());
  world.crew = new CrewTreeStore(dir, { piStore: join(dir, "none.json") });
  const switches = new Switches(db, world, source, dir, { timing: { pollMs: 5, freeMs: 2000, handoffMs: 2000, quietMs: 60_000 } });
  const notices: string[] = [];
  const routing = new LaneRouting(db, { notice: (_t, body) => void notices.push(body) });
  switches.tookOver = (agentId, to, model) => routing.switched(world.state(), agentId, to, model);

  const einstein = world.state().agents.find((a) => a.paneId === "old1")!;
  const done = await switches.settled(switches.start(einstein.name, { model: "openai-codex/gpt-6-astra" }).id);
  assert.equal(done.step, "done", done.says);
  const override = JSON.parse(readFileSync(join(root, ".git/fysiklab/lane-routing.json"), "utf8"));
  assert.deepEqual(override, { runtimes: { einstein: "pi" }, lanes: { einstein: "openai-codex/gpt-6-astra" } });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /einstein lane will start on Pi \(openai-codex\/gpt-6-astra\).*next start/);
  rmSync(parent, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});
