import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Herdr } from "../src/server/herdr.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World } from "../src/server/world.ts";

const agent = { pane_id: "w1:p15", agent: "claude", agent_status: "idle", cwd: "/work/shuttle", name: "samir-claude", agent_session: { value: "s1" } };

function fixture(t: TestContext, script?: (list: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-blind-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const list = join(dir, "agents.json");
  const bin = join(dir, "herdr");
  writeFileSync(bin, script?.(list) ?? `#!/bin/sh\ncat '${list}' || exit 1\n`);
  chmodSync(bin, 0o755);
  let clock = Date.parse("2026-11-01T15:40:00Z");
  const herdr = new Herdr(bin, join(dir, "no.sock"), () => clock);
  return {
    dir, herdr, list,
    show: (agents: unknown[]) => writeFileSync(list, JSON.stringify({ result: { agents } })),
    breakList: () => rmSync(list, { force: true }),
    later: (ms: number) => void (clock += ms),
  };
}

test("one failed read changes nothing; herdr is not answering only after two, and then keeps the last agents for two minutes", async (t) => {
  const { herdr, show, breakList, later } = fixture(t);
  show([agent]);
  await herdr.refresh();
  assert.equal(herdr.available(), true);
  breakList();
  await herdr.refresh();
  assert.equal(herdr.available(), true, "one stall says nothing");
  assert.equal(herdr.live().length, 1);
  later(20_000);
  await herdr.refresh();
  assert.equal(herdr.available(), false, "twice in a row is not answering");
  assert.equal(herdr.live()[0]?.name, "samir-claude", "the last good list still holds the pane");
  later(100_000);
  await herdr.refresh();
  assert.equal(herdr.live().length, 1, "within two minutes of the last good read");
  later(30_000);
  await herdr.refresh();
  assert.deepEqual(herdr.live(), []);
  show([agent]);
  await herdr.refresh();
  assert.equal(herdr.available(), true);
  assert.equal(herdr.live().length, 1);
});

test("a list that takes three seconds on a loaded machine is still a list", async (t) => {
  const { herdr, show } = fixture(t, (list) => `#!/bin/sh\nsleep 3\ncat '${list}'\n`);
  show([agent]);
  await herdr.refresh();
  assert.equal(herdr.available(), true);
  assert.equal(herdr.live().length, 1);
});

test("nobody is called offline while herdr does not answer", async (t) => {
  const { herdr, show, breakList, later } = fixture(t);
  show([agent, { ...agent, pane_id: "w1:p16", name: "other", agent_session: { value: "s2" } }]);
  await herdr.refresh();
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(tmpdir(), "herdr-blind-files"), herdr);
  const world = new World(db, herdr, () => inbox.state(), () => new Date("2026-11-01T15:41:00Z"));
  inbox.submit({ session: { harness: "claude", sessionId: "gone", cwd: "/work/elsewhere" }, item: { type: "milestone", title: "Earlier work" } });
  const [from] = world.state().agents.filter((a) => a.paneId === "w1:p15");
  const away = world.state().agents.find((a) => a.status === "offline")!;
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => void warned.push(String(line));
  t.after(() => { console.warn = warn; });

  const heard = world.messages.say(from!, { to: away.name, text: "Are you there?" });
  assert.equal(heard.deliveries[0]?.offline, away.name, "herdr answers: the sender is told the recipient is offline");

  breakList();
  later(1000);
  await herdr.refresh();
  later(20_000);
  await herdr.refresh();
  assert.equal(herdr.available(), false);
  warned.length = 0;
  const blind = world.messages.say(from!, { to: away.name, text: "Are you still there?" });
  assert.equal(blind.deliveries[0]?.offline, undefined, "herdr is blind: nothing is said about who is offline");
  world.messages.queuedPanes(world.state());
  assert.deepEqual(warned.filter((w) => /is offline/.test(w)), []);
});
