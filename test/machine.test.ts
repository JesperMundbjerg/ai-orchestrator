import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import {
  assess, attribute, browserTrees, elapsedSeconds, HOT_MS, isAutomatedBrowser, KILL_AFTER_MS, LEFT_MS, lineage, Machine, ORPHAN_MS, parseLsofCwds, parsePs, placeFor, TELL_AFTER_MS, TELL_EVERY_MS,
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
40702 40700   1.2 180000    02:09:58 /opt/homebrew/bin/node /Users/me/projects/lantern-search/notes-app/node_modules/next/dist/bin/next dev -p 3010
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
    { path: "/Users/me/projects/lantern-search", teamId: "t1", agentId: null, label: "Note search" },
    { path: "/Users/me/projects/lantern", teamId: null, agentId: "a9", label: "Tom" },
  ];
  // The browser's own folder says nothing; the dev server's does.
  const cwds = new Map<number, string | null>([[76099, "/"], [40703, "/Users/me/projects/lantern-search/notes-app"], [40702, null]]);
  assert.equal(attribute(lineage(procs, 76099), cwds, places)?.teamId, "t1");
  // A folder is in the deepest place containing it, and a sibling folder sharing a prefix is not inside.
  assert.equal(placeFor("/Users/me/projects/lantern/src", places)?.agentId, "a9");
  assert.equal(placeFor("/Users/me/projects/lantern-other", places), null);
  assert.equal(attribute([900, 40700], new Map([[900, "/tmp"]]), places), null);
  assert.deepEqual([...parseLsofCwds("p12\nfcwd\nn/a/b\np13\nfcwd\nn/c\n")], [[12, "/a/b"], [13, "/c"]]);
});

test("a warning needs a sustained load or too many browsers; a browser nobody uses for 10 minutes is for closing, not for the warning", () => {
  const trees = browserTrees(parsePs(PS));
  const owner: Place = { path: "/p", teamId: "t1", agentId: null, label: "Note search" };
  const owners = new Map(trees.map((t) => [t.pid, t.pid === 76099 ? owner : null]));
  const seen = new Map();
  const hot = { since: null as number | null };
  let busy = true;
  const at = (now: number) => assess({ trees, owners, busy: (p) => busy && p === owner, now }, seen, hot);

  // Over 150% together, but not yet for a minute.
  assert.equal(at(0).state.warning, null);
  const hotNow = at(HOT_MS).state;
  assert.deepEqual(hotNow.warning, { why: ["hot"] });
  const probe = hotNow.browsers[0]!;
  assert.equal(probe.label, "Note search browser");
  assert.deepEqual(probe.reasons, ["hot"]);
  // The script's browser uses little of it; the unknown ones are told apart by number.
  assert.deepEqual(hotNow.browsers.find((b) => b.pid === 901)!.reasons, []);
  assert.deepEqual(hotNow.browsers.filter((b) => !b.project).map((b) => b.label).sort(), ["Unknown browser 1", "Unknown browser 2"]);

  // Cooling down clears it. With nobody working on the project for 10 minutes its browser is
  // forgotten: handed over to be closed, not listed, and not part of the load.
  const cool = trees.map((t) => ({ ...t, cpu: 6 }));
  const calm = (now: number) => assess({ trees: cool, owners, busy: (p) => busy && p === owner, now }, seen, hot);
  assert.equal(calm(HOT_MS + 1).state.warning, null);
  busy = false;
  assert.deepEqual(calm(HOT_MS + 2).forgotten, []);
  assert.deepEqual(calm(HOT_MS + 2 + LEFT_MS - 1).forgotten, []);
  const left = calm(HOT_MS + 2 + LEFT_MS);
  assert.deepEqual(left.forgotten.map((f) => [f.tree.pid, f.why, f.idleMinutes]), [[76099, "left", 10]]);
  assert.equal(left.state.warning, null);
  assert.equal(left.state.browsers.some((b) => b.pid === 76099), false);

  const many = Array.from({ length: 6 }, (_, i) => ({ ...cool[0]!, pid: 10 + i }));
  assert.deepEqual(assess({ trees: many, owners: new Map(), busy: () => false, now: 0 }, new Map(), { since: null }).state.warning, { why: ["many"] });
});

test("a browser of no project is left after 10 minutes under 5% CPU, and a young one or a working one is not", () => {
  const base = browserTrees(parsePs(PS)).find((t) => t.pid === 1200)!;
  const run = (tree: typeof base, steps: Array<[number, number]>) => {
    const seen = new Map();
    let last = assess({ trees: [tree], owners: new Map(), busy: () => false, now: 0 }, seen, { since: null });
    for (const [now, cpu] of steps) last = assess({ trees: [{ ...tree, cpu }], owners: new Map(), busy: () => false, now }, seen, { since: null });
    return last.forgotten.map((f) => f.why);
  };
  const old = { ...base, elapsed: 3600, cpu: 1 };
  assert.deepEqual(run(old, [[LEFT_MS - 1, 1]]), []);
  assert.deepEqual(run(old, [[LEFT_MS, 1]]), ["left"]);
  // Busy once in between: the ten minutes start over.
  assert.deepEqual(run(old, [[LEFT_MS - 1, 40], [LEFT_MS, 1], [2 * LEFT_MS - 1, 1]]), []);
  assert.deepEqual(run(old, [[LEFT_MS - 1, 40], [LEFT_MS, 1], [2 * LEFT_MS, 1]]), ["left"]);
  // Not yet ten minutes old, however long it has been watched.
  assert.deepEqual(run({ ...old, elapsed: 120 }, [[LEFT_MS, 1]]), []);
});

function machine(ps: () => string, world: Pick<WorldState, "teams" | "agents">, failKill?: NodeJS.ErrnoException) {
  let now = 0;
  const lookedUp: number[][] = [];
  const killed: Array<[number, string]> = [];
  const told: Array<[string, string]> = [];
  const m = new Machine(() => world, {
    ps: async () => ps(),
    cwds: async (pids) => {
      lookedUp.push(pids);
      return new Map(pids.map((pid) => [pid, pid === 40703 ? "/Users/me/projects/lantern-search/notes-app" : "/"]));
    },
    kill: (pid, signal) => {
      if (failKill) throw failKill;
      killed.push([pid, signal]);
    },
    now: () => now,
    sleep: async () => {},
  });
  m.tellLead = (teamId, text) => (told.push([teamId, text]), true);
  return { m, lookedUp, killed, told, advance: (ms: number) => (now += ms) };
}

const WORLD = {
  teams: [{ id: "t1", name: "Note search", purpose: "", handsTo: null, path: "/Users/me/projects/lantern-search", branch: null, standing: false, createdAt: "", status: "idle", blockedBy: [] }],
  agents: [],
} as unknown as Pick<WorldState, "teams" | "agents">;

/** Someone on the Note search project is working. */
const WORLD_BUSY = { ...WORLD, agents: [{ id: "a1", teamId: "t1", status: "working", cwd: null, name: "rowan" }] } as unknown as Pick<WorldState, "teams" | "agents">;
const MIN = 60_000;

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
  const { m, lookedUp, told, advance } = machine(() => ps, WORLD_BUSY);
  await m.read();
  assert.equal(lookedUp.length, 1);
  assert.equal(m.state().browsers[0]!.label, "Note search browser");
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

test("a browser whose starter is gone closes after a minute, keeping its project, and its lead is told once", async () => {
  // The dev server that started the probe browser exits: launchd takes the browser over.
  const orphaned = PS.replace("76099 40703", "76099     1");
  let ps = PS;
  const { m, killed, told, advance } = machine(() => ps, WORLD);
  await m.read();
  ps = orphaned;
  advance(15_000);
  await m.read();
  advance(ORPHAN_MS - 1);
  await m.read();
  assert.equal(killed.length, 0, "not before a minute");
  advance(1);
  await m.read();
  // Nobody on its project is working, and its starter is gone: nothing is waiting for it.
  assert.deepEqual(killed.slice(0, 1), [[76099, "SIGTERM"]]);
  assert.deepEqual(m.state().browsers.map((b) => b.pid).sort((a, b) => a - b), [901, 1200]);
  assert.equal(m.state().closedToday, 1);
  assert.equal(told.length, 1);
  assert.equal(told[0]![0], "t1");
  assert.match(told[0]![1], /^Closed a headless browser left running by Note search: 3 pages, the process that started it had exited; close browsers in a finally/);
  await m.settled();
  // Nothing but that one browser's main process was signalled, and no more on later readings.
  advance(15_000);
  await m.read();
  assert.deepEqual(killed.map(([pid]) => pid), [76099, 76099]);
});

test("an orphan of a project that is working is not closed after a minute (it may be detached on purpose), nor one of no project that is busy", async () => {
  const orphaned = PS.replace("76099 40703", "76099     1");
  const working = machine(() => orphaned, WORLD_BUSY);
  for (let t = 0; t < (3 * 60 * MIN) / 15_000; t++) {
    await working.m.read();
    working.advance(15_000);
  }
  assert.equal(working.killed.length, 0, "it is in use as far as the office can tell, however long its starter has been gone");
  assert.equal(working.m.state().closedToday, 0);
  // Nobody on the project works, and its starter went a minute ago: closed.
  let ps = PS;
  const quiet = machine(() => ps, WORLD);
  await quiet.m.read();
  ps = orphaned;
  quiet.advance(1);
  await quiet.m.read();
  quiet.advance(ORPHAN_MS);
  await quiet.m.read();
  assert.deepEqual(quiet.killed.slice(0, 1), [[76099, "SIGTERM"]]);

  // An orphan of no project is closed after a minute only if it uses under 5% CPU.
  const base = browserTrees(parsePs(PS)).find((t) => t.pid === 1200)!;
  const orphan = { ...base, orphan: true, elapsed: 30 };
  const run = (cpu: number) => {
    const seen = new Map();
    assess({ trees: [{ ...orphan, cpu }], owners: new Map(), busy: () => false, now: 0 }, seen, { since: null });
    return assess({ trees: [{ ...orphan, cpu }], owners: new Map(), busy: () => false, now: ORPHAN_MS }, seen, { since: null }).forgotten.map((f) => f.why);
  };
  assert.deepEqual(run(1), ["orphaned"]);
  assert.deepEqual(run(60), []);
});

test("a browser of an idle project closes after 10 minutes; one whose owner is alive and whose project is working never does", async () => {
  const idle = machine(() => PS, WORLD);
  await idle.m.read();
  idle.advance(LEFT_MS - 15_000);
  await idle.m.read();
  assert.deepEqual(idle.killed, []);
  idle.advance(15_000);
  await idle.m.read();
  assert.deepEqual(idle.killed.slice(0, 1), [[76099, "SIGTERM"]]);
  assert.equal(idle.m.state().closedToday, 1);
  assert.equal(idle.told.length, 1);
  assert.match(idle.told[0]![1], /3 pages, 10 min idle/);
  await idle.m.settled();

  const busy = machine(() => PS, WORLD_BUSY);
  for (let t = 0; t < (3 * 60 * MIN) / 15_000; t++) {
    await busy.m.read();
    busy.advance(15_000);
  }
  assert.deepEqual(busy.killed, [], "a working project's browser may be mid-screenshot");
  assert.equal(busy.m.state().closedToday, 0);
  assert.deepEqual(busy.told.filter(([, text]) => text.startsWith("Closed")), []);
});

test("nothing that is not a headless browser's main process is ever closed automatically", async () => {
  // A dev server and your own Chrome, both orphans for hours, beside browsers that are also forgotten.
  const ps = `${PS}\n 7000     1   0.0  50000 05:00:00 next-server (v16.3.4)\n 7001     1   0.0  50000 05:00:00 /opt/homebrew/bin/node /x/dev.js`;
  const { m, killed, advance } = machine(() => ps, WORLD);
  for (let t = 0; t < 40; t++) {
    await m.read();
    advance(MIN);
  }
  await m.settled();
  const signalled = new Set(killed.map(([pid]) => pid));
  // Only the probe (its project is idle) may be closed; the other browsers use over 5% CPU and have no project.
  assert.deepEqual([...signalled].filter((pid) => ![76099].includes(pid)), []);
  for (const pid of [500, 501, 7000, 7001, 40703, 76156, 902]) assert.equal(signalled.has(pid), false);
});

test("a browser that ignores SIGTERM gets SIGKILL 10 s later, to its main process only; one that quit, or a reused pid, does not", async () => {
  const orphaned = PS.replace("76099 40703", "76099     1");
  const slept: number[] = [];
  // Ignores SIGTERM: still listed when the wait is over.
  const first = (after: () => string) => {
    let n = 0;
    return () => (n++ ? after() : PS);
  };
  const stubborn = machine(first(() => orphaned), WORLD);
  (stubborn.m as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => void slept.push(ms);
  await stubborn.m.read();
  await stubborn.m.read();
  stubborn.advance(ORPHAN_MS);
  await stubborn.m.read();
  await stubborn.m.settled();
  assert.deepEqual(slept, [KILL_AFTER_MS]);
  assert.deepEqual(stubborn.killed, [[76099, "SIGTERM"], [76099, "SIGKILL"]]);

  // Quits on SIGTERM: gone from the process list by then.
  const quits = machine(first(() => (quitsKilled.length ? orphaned.split("\n").filter((l) => !/^\s*761\d\d|^\s*76099|^\s*81453|^\s*82263/.test(l)).join("\n") : orphaned)), WORLD);
  const quitsKilled = quits.killed;
  await quits.m.read();
  await quits.m.read();
  quits.advance(ORPHAN_MS);
  await quits.m.read();
  await quits.m.settled();
  assert.deepEqual(quits.killed, [[76099, "SIGTERM"]]);

  // The pid now belongs to something else: a different command is not signalled again.
  const reused = machine(first(() => (reusedKilled.length ? orphaned.replace(SHELL + " --disable-field-trial-config", "/usr/bin/vim") : orphaned)), WORLD);
  const reusedKilled = reused.killed;
  await reused.m.read();
  await reused.m.read();
  reused.advance(ORPHAN_MS);
  await reused.m.read();
  await reused.m.settled();
  assert.deepEqual(reused.killed, [[76099, "SIGTERM"]]);
});

test("a browser the office may not signal stays listed as a warning for the founder", async () => {
  const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
  const orphaned = PS.replace("76099 40703", "76099     1");
  let ps = PS;
  const { m, advance, told } = machine(() => ps, WORLD, denied);
  await m.read();
  ps = orphaned;
  await m.read();
  advance(ORPHAN_MS);
  await m.read();
  assert.equal(m.state().browsers.some((b) => b.pid === 76099), true, "listed at once");
  const state = m.state();
  assert.equal(state.closedToday, 0);
  assert.deepEqual(state.browsers.find((b) => b.pid === 76099)!.reasons.includes("forgotten"), true);
  assert.deepEqual(state.warning?.why.includes("forgotten"), true);
  assert.equal(told.length, 0);
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
