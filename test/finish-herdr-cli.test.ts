import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr } from "../src/server/herdr.ts";

// The commands finishing a project sends to herdr, against a stand-in binary that logs its arguments.
// (Never the real herdr: the binary here is a script in a temporary folder.)

function stub(workspaces: unknown[][]) {
  const dir = mkdtempSync(join(tmpdir(), "finish-herdr-cli-"));
  const log = join(dir, "calls.log");
  const state = join(dir, "state");
  writeFileSync(state, "0");
  writeFileSync(join(dir, "workspaces.json"), JSON.stringify(workspaces));
  const bin = join(dir, "herdr");
  // Each `workspace list` answers the next entry of workspaces.json; every call is logged.
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const out = (result) => console.log(JSON.stringify({ result }));
if (args[0] === "workspace" && args[1] === "list") {
  const i = Number(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
  fs.writeFileSync(${JSON.stringify(state)}, String(i + 1));
  const all = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "workspaces.json"))}, "utf8"));
  out({ workspaces: all[Math.min(i, all.length - 1)] });
} else if (args[0] === "pane" && args[1] === "list") {
  out({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/r", foreground_cwd: "/r/src" }, { pane_id: "w2:p1", workspace_id: "w2" }] });
} else if (args[0] === "worktree" && args[1] === "create") {
  out({ root_pane: { pane_id: "w17:p1" } });
} else out({});
`);
  chmodSync(bin, 0o755);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  return { herdr: new Herdr(bin, join(dir, "none.sock")), calls };
}

const ws = (id: string, extra: object = {}) => ({ workspace_id: id, label: id, pane_count: 1, ...extra });
const main = (id: string, root: string) => ws(id, { worktree: { checkout_path: root, repo_root: root, is_linked_worktree: false } });
const linked = (id: string, path: string, root: string) => ws(id, { worktree: { checkout_path: path, repo_root: root, is_linked_worktree: true } });

test("panes lists shells with both folders, and workspaces says which checkout each is open on", async () => {
  const { herdr } = stub([[main("wJ", "/r"), linked("w17", "/r-x", "/r"), ws("w9")]]);
  assert.deepEqual(await herdr.panes(), [
    { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", cwd: "/r", foregroundCwd: "/r/src" },
    { paneId: "w2:p1", workspaceId: "w2", tabId: null, cwd: null, foregroundCwd: null },
  ]);
  assert.deepEqual((await herdr.workspaces()).map((w) => [w.workspaceId, w.checkoutPath, w.repoRoot, w.linked]), [
    ["wJ", "/r", "/r", false], ["w17", "/r-x", "/r", true], ["w9", null, null, false],
  ]);
});

test("making a worktree reports the main checkout's workspace herdr opened beside it, and not one that was already open", async () => {
  const opened = stub([[], [main("wJ", "/r"), linked("w17", "/r-x", "/r")]]);
  const first = await opened.herdr.createWorktree("/r", { path: "/r-x", branch: "worktree-x", base: null, label: "X" });
  assert.deepEqual(first, { paneId: "w17:p1", alsoOpened: ["wJ"] });

  const already = stub([[main("wF", "/r")], [main("wF", "/r"), linked("w17", "/r-x", "/r")]]);
  assert.deepEqual((await already.herdr.createWorktree("/r", { path: "/r-x", branch: "worktree-x", base: null, label: "X" })).alsoOpened, []);
});

test("a workspace is closed by its id alone, never with --group", async () => {
  const { herdr, calls } = stub([[]]);
  await herdr.closeWorkspace("wJ");
  assert.deepEqual(calls(), [["workspace", "close", "wJ"]]);
});
