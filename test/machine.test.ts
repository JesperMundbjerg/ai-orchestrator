import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import {
  assess, attribute, browserTrees, elapsedSeconds, FORGOTTEN_MS, HOT_MS, isAutomatedBrowser, lineage, Machine, parseLsofCwds, parsePs, placeFor, TELL_AFTER_MS, TELL_EVERY_MS,
  type Place,
} from "../src/server/machine.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { WorldState } from "../src/shared/types.ts";

const SHELL = "/Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HELPER = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)";

/**
 * Recorded `ps -axww -o pid=,ppid=,pcpu=,rss=,etime=,command=` on macOS, flags trimmed: a dev
 * server's probe browser (the one that pegged the founder's Mac), your own Chrome, a script's
 * headed Playwright Chrome and a headless Firefox.
 */
const PS = `
    1     0   0.1  12000 3-02:11:09 /sbin/launchd
40700     1   0.0  30000    02:10:00 /bin/zsh -l
40702 40700   1.2 180000    02:09:58 /opt/homebrew/bin/node /Users/me/projects/space-shuttle-cosmology-lesson/space-app/node_modules/next/dist/bin/next dev -p 3010
40703 40702  12.0 420000    02:09:57 next-server (v16.3.4)
76099 40703   0.0  93744       12:28 ${SHELL} --disable-field-trial-config --disable-background-networking --headless --user-data-dir=/var/folders/zn/T/playwright_chromiumdev_profile-8GHVLY --remote-debugging-pipe
76137 76099  31.4 116128       12:28 ${SHELL} --type=gpu-process --no-sandbox --headless --use-angle=metal
76138 76099   0.0  56016       12:28 ${SHELL} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US
76156 76099  94.9 393072       12:28 ${SHELL} --type=renderer --headless=old --no-sandbox
81453 76099  73.9 409696       11:55 ${SHELL} --type=renderer --headless=old --no-sandbox
82263 76099  49,0 287680       11:24 ${SHELL} --type=renderer --headless=old --no-sandbox
  500     1   3.0 600000 1-04:00:00 ${CHROME}
  501   500  40.0 300000 1-03:59:00 ${HELPER} --type=renderer --lang=en-US
  900 40700   0.5  60000       05:00 node /tmp/shot.js
  901   900   2.0 200000       04:59 ${CHROME} --remote-debugging-port=0 --user-data-dir=/var/folders/zn/T/puppeteer_dev_chrome_profile-abc
  902   901   5.0 150000       04:58 ${HELPER} --type=renderer --extension-process
  903   901   6.0 150000       04:58 ${HELPER} --type=renderer
 1200 40700   0.0 250000       01:00 /Applications/Firefox.app/Contents/MacOS/firefox -headless -profile /tmp/playwright_firefoxdev_profile-x
 1201  1200   9.0 100000       00:59 /Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -contentproc -childID 1 -isForBrowser 1200 tab
garbage line
`;

test("ps output is read, including ps's elapsed times and a decimal comma", () => {
  const procs = parsePs(PS);
  assert.equal(procs.length, 18);
  assert.equal(procs.find((p) => p.pid === 82263)!.cpu, 49);
  assert.equal(elapsedSeconds("12:28"), 748);
  assert.equal(elapsedSeconds("02:09:57"), 7797);
  assert.equal(elapsedSeconds("3-02:11:09"), 3 * 86_400 + 7869);
  assert.equal(procs.find((p) => p.pid === 76099)!.command.startsWith(SHELL), true);
});

test("each automated browser is found with everything under it; your own Chrome is never one", () => {
  const trees = browserTrees(parsePs(PS));
  assert.deepEqual(trees.map((t) => t.pid).sort((a, b) => a - b), [901, 1200, 76099]);
  const probe = trees.find((t) => t.pid === 76099)!;
  assert.deepEqual(probe.pids.sort(), [76099, 76137, 76138, 76156, 81453, 82263].sort());
  assert.equal(probe.pages, 3);
  assert.equal(probe.cpu, 249);
  assert.equal(probe.elapsed, 748);
  // An extension's renderer is not a page.
  assert.equal(trees.find((t) => t.pid === 901)!.pages, 1);
  assert.equal(trees.find((t) => t.pid === 1200)!.pages, 1);
  assert.equal(isAutomatedBrowser(CHROME), false);
  assert.equal(isAutomatedBrowser(`${HELPER} --type=renderer`), false);
  assert.equal(isAutomatedBrowser("/opt/homebrew/bin/node /x/playwright/cli.js test"), false);
  assert.equal(isAutomatedBrowser(`${CHROME} --headless=new`), true);
});

test("a browser belongs to the project where whatever started it works", () => {
  const procs = parsePs(PS);
  assert.deepEqual(lineage(procs, 76099), [76099, 40703, 40702, 40700]);
  const places: Place[] = [
    { path: "/Users/me/projects/space-shuttle-cosmology-lesson", teamId: "t1", agentId: null, label: "Cosmology lesson" },
    { path: "/Users/me/projects/space-shuttle", teamId: null, agentId: "a9", label: "Tom" },
  ];
  // The browser's own folder says nothing; the dev server's does.
  const cwds = new Map<number, string | null>([[76099, "/"], [40703, "/Users/me/projects/space-shuttle-cosmology-lesson/space-app"], [40702, null]]);
  assert.equal(attribute(lineage(procs, 76099), cwds, places)?.teamId, "t1");
  // A folder is in the deepest place containing it, and a sibling folder sharing a prefix is not inside.
  assert.equal(placeFor("/Users/me/projects/space-shuttle/src", places)?.agentId, "a9");
  assert.equal(placeFor("/Users/me/projects/space-shuttle-other", places), null);
  assert.equal(attribute([900, 40700], new Map([[900, "/tmp"]]), places), null);
  assert.deepEqual([...parseLsofCwds("p12\nfcwd\nn/a/b\np13\nfcwd\nn/c\n")], [[12, "/a/b"], [13, "/c"]]);
});

test("a warning needs a sustained load, a browser left behind, or too many of them", () => {
  const trees = browserTrees(parsePs(PS));
  const owner: Place = { path: "/p", teamId: "t1", agentId: null, label: "Cosmology lesson" };
  const owners = new Map(trees.map((t) => [t.pid, t.pid === 76099 ? owner : null]));
  const seen = new Map();
  const hot = { since: null as number | null };
  let busy = true;
  const at = (now: number) => assess({ trees, owners, busy: (p) => busy && p === owner, now }, seen, hot);

  // Over 150% together, but not yet for a minute.
  assert.equal(at(0).warning, null);
  const hotNow = at(HOT_MS);
  assert.deepEqual(hotNow.warning, { why: ["hot"] });
  const probe = hotNow.browsers[0]!;
  assert.equal(probe.label, "Cosmology lesson browser");
  assert.deepEqual(probe.reasons, ["hot"]);
  // The script's browser uses little of it; the unknown ones are told apart by number.
  assert.deepEqual(hotNow.browsers.find((b) => b.pid === 901)!.reasons, []);
  assert.deepEqual(hotNow.browsers.filter((b) => !b.project).map((b) => b.label).sort(), ["Unknown browser 1", "Unknown browser 2"]);

  // Cooling down clears it; a browser whose project has nobody working for 20 min is flagged by itself.
  const cool = trees.map((t) => ({ ...t, cpu: 5 }));
  const calm = (now: number) => assess({ trees: cool, owners, busy: (p) => busy && p === owner, now }, seen, hot);
  assert.equal(calm(HOT_MS + 1).warning, null);
  busy = false;
  assert.equal(calm(HOT_MS + 2).warning, null);
  const left = calm(HOT_MS + 2 + FORGOTTEN_MS);
  assert.deepEqual(left.warning, { why: ["forgotten"] });
  assert.deepEqual(left.browsers.find((b) => b.pid === 76099)!.reasons, ["forgotten"]);

  const many = Array.from({ length: 6 }, (_, i) => ({ ...cool[0]!, pid: 10 + i }));
  assert.deepEqual(assess({ trees: many, owners: new Map(), busy: () => false, now: 0 }, new Map(), { since: null }).warning, { why: ["many"] });
});

function machine(ps: () => string, world: Pick<WorldState, "teams" | "agents">) {
  let now = 0;
  const lookedUp: number[][] = [];
  const killed: Array<[number, string]> = [];
  const told: Array<[string, string]> = [];
  const m = new Machine(() => world, {
    ps: async () => ps(),
    cwds: async (pids) => {
      lookedUp.push(pids);
      return new Map(pids.map((pid) => [pid, pid === 40703 ? "/Users/me/projects/space-shuttle-cosmology-lesson/space-app" : "/"]));
    },
    kill: (pid, signal) => void killed.push([pid, signal]),
    now: () => now,
  });
  m.tellLead = (teamId, text) => (told.push([teamId, text]), true);
  return { m, lookedUp, killed, told, advance: (ms: number) => (now += ms) };
}

const WORLD = {
  teams: [{ id: "t1", name: "Cosmology lesson", purpose: "", handsTo: null, path: "/Users/me/projects/space-shuttle-cosmology-lesson", branch: null, standing: false, createdAt: "", status: "idle", blockedBy: [] }],
  agents: [],
} as unknown as Pick<WorldState, "teams" | "agents">;

test("Close signals only a listed browser's main process; nothing else can be signalled", async () => {
  const { m, killed } = machine(() => PS, WORLD);
  await m.read();
  for (const pid of [40703, 500, 501, 76156, 1, Number(process.pid), 99999]) {
    await assert.rejects(m.close(pid), (e: { status?: number }) => e.status === 409 || e.status === 400);
  }
  assert.deepEqual(killed, []);
  assert.deepEqual(await m.close(76099), { ok: true, closed: 76099 });
  assert.deepEqual(killed, [[76099, "SIGTERM"]]);
  // A browser that has gone since is refused, since the list is read again first.
  const gone = machine(() => PS.split("\n").filter((l) => !l.includes(" 901 ") && !l.startsWith("  901")).join("\n"), WORLD);
  await gone.m.read();
  await assert.rejects(gone.m.close(901));
});

test("a flagged browser's lead is told once, a project at most every 15 minutes, and folders are looked up once", async () => {
  let ps = PS;
  const { m, lookedUp, told, advance } = machine(() => ps, WORLD);
  await m.read();
  assert.equal(lookedUp.length, 1);
  assert.equal(m.state().browsers[0]!.label, "Cosmology lesson browser");
  // Hot from the second reading on; flagged a minute later, told three minutes after that.
  for (let t = 0; t < (HOT_MS + TELL_AFTER_MS) / 15_000; t++) {
    advance(15_000);
    await m.read();
  }
  assert.equal(told.length, 1);
  assert.equal(told[0]![0], "t1");
  assert.match(told[0]![1], /process 76099: 3 pages, 249% CPU/);
  assert.match(told[0]![1], /browser\.close\(\)/);
  assert.equal(lookedUp.length, 1, "known processes are not looked up again");
  advance(60 * 60_000);
  await m.read();
  assert.equal(told.length, 1, "the same browser is told about once");

  // A new browser of the same project, flagged at once: told only when the project's quiet time is over.
  ps = PS.replaceAll("76099", "77777");
  advance(15_000);
  await m.read();
  assert.equal(lookedUp.length, 2);
  for (let t = 0; t < TELL_EVERY_MS / 15_000; t++) {
    advance(15_000);
    await m.read();
  }
  assert.equal(told.length, 2);
});

test("the office's note reaches the lead as the office's, typed like a message, not as yours", async () => {
  const db = openDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "machine-test-"));
  const live: LiveAgent[] = [{ paneId: "p1", harness: "claude", sessionId: "s1", cwd: dir, status: "idle", title: null, name: "lead" }];
  const prompts: string[] = [];
  const source = {
    available: () => true,
    live: () => live,
    prompt: async (_pane: string, text: string) => void prompts.push(text),
    notify: async () => {},
  } as unknown as AgentSource;
  const inbox = new Inbox(db, join(dir, "files"), { available: () => true, forSession: () => null, resolvePane: () => null });
  const world = new World(db, source, () => inbox.state());
  const team = await world.createTeam({ name: "Crew", standing: true });
  const lead = world.state().agents[0]!;
  world.updateAgent(lead.id, { teamId: team.id, role: "lead" });
  assert.equal(world.tellLead(team.id, "A headless browser is still running."), true);
  await world.react();
  assert.match(prompts[0]!, /^\[From the office\]\n\nA headless browser is still running\./);
  const state = world.state();
  assert.equal(state.messages[0]!.fromOffice, true);
  assert.equal(state.withFounder.length, 0);
});
