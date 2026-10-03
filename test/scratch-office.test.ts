import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertScratchEnvironment, inspectScratchProcess, spawnScratchOffice, stopScratchRecord, type ScratchRecord } from "../scripts/lib/scratch-office.ts";

const envFor = (home: string, port: number): NodeJS.ProcessEnv => ({
  ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port),
  HERDR_SOCKET_PATH: "/nonexistent", HERDR_BIN_PATH: "/usr/bin/false",
  INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0",
});
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(r => server.close(() => r()));
  return port === 4870 ? freePort() : port;
}
async function answering(port: number, child: { exitCode: number | null; signalCode: string | null }): Promise<void> {
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, "office exited before answering");
    assert.equal(child.signalCode, null, "office was signalled before answering");
    try { if ((await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(50);
  }
  assert.fail("scratch office did not answer");
}

test("scratch cleanup stops only its recorded group; another office keeps answering, and mismatched identity never kills", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-owned-cleanup-"));
  const offices: Awaited<ReturnType<typeof spawnScratchOffice>>[] = [];
  t.after(async () => {
    try { for (const office of offices) await office.stop(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const firstPort = await freePort();
  let secondPort = await freePort();
  while (secondPort === firstPort) secondPort = await freePort();
  const first = await spawnScratchOffice(process.execPath, [resolve("src/server/main.ts")], { env: envFor(join(dir, "one"), firstPort), stdio: "ignore" });
  offices.push(first);
  const second = await spawnScratchOffice(process.execPath, [resolve("src/server/main.ts")], { env: envFor(join(dir, "two"), secondPort), stdio: "ignore" });
  offices.push(second);
  await Promise.all([answering(firstPort, first.child), answering(secondPort, second.child)]);
  assert.equal(first.record.pgid, first.child.pid);
  assert.equal(first.record.port, firstPort);
  assert.ok(first.record.start);
  assert.deepEqual(first.record.args, [resolve("src/server/main.ts")]);
  for (const mismatch of [{ start: "reused-start-time" }, { command: "another command" }, { token: "another-launch" }]) {
    assert.equal(await stopScratchRecord({ ...second.record, ...mismatch }), "gone-or-changed");
    await answering(secondPort, second.child);
  }
  await first.stop();
  assert.equal(inspectScratchProcess(first.record.pid), null);
  await assert.rejects(fetch(`http://127.0.0.1:${firstPort}/api/state`, { signal: AbortSignal.timeout(500) }));
  await first.stop(); // idempotent cleanup does not select a new target
  assert.ok(inspectScratchProcess(second.record.pid));
  await answering(secondPort, second.child);
});

test("refuses live port, live data (including symlink aliases), real HOME and enabled integrations before spawning", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "inbox-owned-guard-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = envFor(home, 54321);
  assert.equal(assertScratchEnvironment(env), 54321);
  await assert.rejects(spawnScratchOffice("nonexistent-executable", [], { env: { ...env, INBOX_PORT: "4870" } }), /never 4870/);
  assert.throws(() => assertScratchEnvironment({ ...env, INBOX_DATA_DIR: join(homedir(), ".review-inbox") }), /real ~\/\.review-inbox/);
  symlinkSync(homedir(), join(home, "alias"));
  assert.throws(() => assertScratchEnvironment({ ...env, INBOX_DATA_DIR: join(home, "alias", ".review-inbox") }), /real ~\/\.review-inbox/);
  assert.throws(() => assertScratchEnvironment({ ...env, HOME: homedir() }), /isolated HOME/);
  assert.throws(() => assertScratchEnvironment({ ...env, INBOX_BROWSER_CLEANUP: "1" }), /INBOX_BROWSER_CLEANUP=0/);
});

const fake: ScratchRecord = { pid: 12345, pgid: 12345, start: "start-a", command: "node fixture.ts", token: "launch-a", executable: "node", args: ["fixture.ts"], port: 54321 };
test("gone or reused PID emits no signal; escalation rechecks identity and targets only the recorded group", async () => {
  const calls: Array<[number, string]> = [];
  const signal = (pid: number, sig: NodeJS.Signals) => { calls.push([pid, sig]); };
  assert.equal(await stopScratchRecord(fake, { inspect: () => null, signal }), "gone-or-changed");
  assert.equal(await stopScratchRecord(fake, { inspect: () => ({ ...fake, start: "start-b" }), signal }), "gone-or-changed");
  assert.deepEqual(calls, []);
  let inspections = 0;
  await stopScratchRecord(fake, { termTimeoutMs: 0, inspect: () => ++inspections < 3 ? fake : { ...fake, start: "start-b" }, signal });
  assert.deepEqual(calls, [[-fake.pgid, "SIGTERM"]], "PID reuse between TERM and KILL must suppress escalation");
  calls.length = 0;
  let current: ScratchRecord | null = fake;
  await stopScratchRecord(fake, { termTimeoutMs: 0, inspect: () => current, signal: (pid, sig) => { signal(pid, sig); if (sig === "SIGKILL") current = null; } });
  assert.deepEqual(calls, [[-fake.pgid, "SIGTERM"], [-fake.pgid, "SIGKILL"]]);
});
