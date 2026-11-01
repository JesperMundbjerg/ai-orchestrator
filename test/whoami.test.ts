import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Herdr } from "../src/server/herdr.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World } from "../src/server/world.ts";

const CWD = "/work/space-shuttle";
const SAMIR_SESSION = "989823ee";

/** herdr as the office sees it: `agent list` prints a file, which a test can break the way a timeout does. */
function office(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "whoami-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const list = join(dir, "agents.json");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\ncat '${list}' || exit 1\n`);
  chmodSync(bin, 0o755);
  const show = (agents: Array<Record<string, unknown>>) => writeFileSync(list, JSON.stringify({ result: { agents } }));
  const breakList = () => rmSync(list, { force: true });
  let clock = Date.parse("2026-11-01T14:26:00Z");
  const herdr = new Herdr(bin, join(dir, "no.sock"), () => clock);
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), herdr);
  const world = new World(db, herdr, () => inbox.state(), () => new Date(clock));
  return { herdr, world, inbox, show, breakList, later: (ms: number) => void (clock += ms) };
}

const samir = { pane_id: "w1:p15", agent: "claude", agent_status: "working", cwd: CWD, name: "samir-claude", agent_session: { value: SAMIR_SESSION } };

/** Freja, the unnamed agent that posted from the checkout earlier and is offline now, and Samir, the named lead who runs there. */
async function seat(t: Parameters<typeof office>[0]) {
  const o = office(t);
  o.inbox.submit({ session: { harness: "claude", sessionId: "old", cwd: CWD }, item: { type: "milestone", title: "Earlier work" } });
  o.show([samir]);
  await o.herdr.refresh();
  const agents = o.world.state().agents;
  const freja = agents.find((a) => a.paneId === null && a.cwd === CWD)!;
  const lead = agents.find((a) => a.paneId === "w1:p15")!;
  const team = await o.world.createTeam({ name: "Mission Control", standing: true });
  o.world.updateAgent(lead.id, { teamId: team.id, role: "lead" });
  assert.notEqual(freja.id, lead.id);
  return { ...o, freja, lead };
}

test("a session herdr reports in a pane is that pane's agent, not the unnamed one in the same checkout", async (t) => {
  const { world, lead } = await seat(t);
  assert.equal(world.resolve({ harness: "claude", sessionId: SAMIR_SESSION, cwd: CWD }).id, lead.id);
  assert.equal(world.resolve({ paneId: "w1:p15" }).id, lead.id);
});

test("one failed herdr read does not turn the lead into the unnamed agent of its checkout", async (t) => {
  const { world, herdr, lead, breakList } = await seat(t);
  breakList();
  await herdr.refresh();
  assert.equal(world.resolve({ harness: "claude", sessionId: SAMIR_SESSION, cwd: CWD }).id, lead.id);
  assert.equal(world.resolve({ paneId: "w1:p15" }).id, lead.id);
  assert.match(world.brief({ harness: "claude", sessionId: SAMIR_SESSION, cwd: CWD }).text, new RegExp(`^You are ${lead.name} `));
});

test("herdr staying silent for good empties the office again", async (t) => {
  const { herdr, breakList, later } = await seat(t);
  breakList();
  await herdr.refresh();
  assert.equal(herdr.live().length, 1);
  later(5 * 60_000);
  await herdr.refresh();
  assert.deepEqual(herdr.live(), []);
  assert.equal(herdr.available(), false);
});

test("a pane held by a named live agent never falls back to the checkout's unnamed agent", async (t) => {
  const { world, freja } = await seat(t);
  world.hiddenPanes = () => new Set(["w1:p15"]);
  const caller = { harness: "claude" as const, sessionId: SAMIR_SESSION, cwd: CWD };
  assert.throws(() => world.resolve(caller), (err: Error) => !/Freja/.test(err.message) && /w1:p15/.test(err.message));
  assert.notEqual(world.state().agents.find((a) => a.id === freja.id)?.paneId, "w1:p15");
});

test("with nothing live in the pane, the checkout's agent is still found", async (t) => {
  const { world, show, herdr, freja } = await seat(t);
  show([]);
  await herdr.refresh();
  assert.equal(world.resolve({ harness: "claude", sessionId: "unknown", cwd: CWD }).id, freja.id);
});
