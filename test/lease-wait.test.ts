import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentClientError } from "../src/shared/agent-client.ts";
import { MAX_WAIT_SECONDS, type LeaseResult } from "../src/shared/leases.ts";
import { LEASE_HELP, POLL_FAST_MS, POLL_SLOW_AFTER_MS, POLL_SLOW_MS, isTransient, waitForLease, waitSeconds, type WaitEnv } from "../src/cli/lease.ts";

const answer = (state: "held" | "queued"): LeaseResult => ({ you: { state, position: state === "queued" ? 1 : null, leaseId: "l1" }, text: state } as unknown as LeaseResult);

/** A clock that only moves when the wait sleeps: no real waiting. */
function fake() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const env: WaitEnv = { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, log: (line) => logs.push(line) };
  return { env, sleeps, logs, elapsed: (from = 1_000_000) => t - from };
}
const http = (status: number) => new AgentClientError(`inbox answered ${status}`, { kind: "http", status, code: "x" });
const timeout = () => new AgentClientError("inbox request timed out", { kind: "timeout", code: "timeout" });
const unreachable = () => new AgentClientError("could not reach inbox", { kind: "transport", code: "transport_error" });

test("the maximum wait is two hours and the help says so", () => {
  assert.equal(MAX_WAIT_SECONDS, 7200);
  assert.match(LEASE_HELP, /7200/);
});

test("a wait longer than the old 120 s limit is honoured, and the lease granted late is returned", async () => {
  const f = fake();
  let polls = 0;
  const out = await waitForLease(answer("queued"), async () => { polls++; return f.elapsed() >= 1_800_000 ? answer("held") : answer("queued"); }, 1800, f.env);
  assert.equal(out.result.you.state, "held");
  assert.ok(out.waitedMs >= 1_800_000 - POLL_SLOW_MS && out.waitedMs <= 1_800_000, `waited ${out.waitedMs}`);
  assert.equal(out.polls, polls);
});

test("still queued at the deadline returns queued after exactly the asked time", async () => {
  const f = fake();
  const out = await waitForLease(answer("queued"), async () => answer("queued"), 300, f.env);
  assert.equal(out.result.you.state, "queued");
  assert.equal(out.waitedMs, 300_000);
});

test("polls every 2 s for the first minute, then every 5 s", async () => {
  const f = fake();
  await waitForLease(answer("queued"), async () => answer("queued"), 90, f.env);
  const fast = f.sleeps.filter((ms) => ms === POLL_FAST_MS).length;
  assert.equal(fast, POLL_SLOW_AFTER_MS / POLL_FAST_MS);
  assert.deepEqual([...new Set(f.sleeps.slice(fast))], [POLL_SLOW_MS]);
  assert.equal(f.sleeps.reduce((a, b) => a + b, 0), 90_000);
});

test("no wait asked, or already held, does not poll", async () => {
  const f = fake();
  const never = async () => { throw new Error("polled"); };
  assert.equal((await waitForLease(answer("queued"), never, 0, f.env)).polls, 0);
  assert.equal((await waitForLease(answer("held"), never, 60, f.env)).polls, 0);
});

test("timeouts, an unreachable office and a 5xx mid-wait keep waiting; one line per streak", async () => {
  const f = fake();
  const failures = [timeout(), unreachable(), http(503), timeout()];
  let n = 0;
  const out = await waitForLease(answer("queued"), async () => {
    n++;
    if (n <= failures.length) throw failures[n - 1];
    return n < 8 ? answer("queued") : answer("held");
  }, 600, f.env);
  assert.equal(out.result.you.state, "held");
  assert.equal(f.logs.length, 2, f.logs.join("\n")); // the first failure, and the recovery
  assert.match(f.logs[0] ?? "", /still waiting/);
  assert.match(f.logs[1] ?? "", /answers again/);
});

test("an office that never comes back lets the wait run to its deadline, still queued", async () => {
  const f = fake();
  const out = await waitForLease(answer("queued"), async () => { throw unreachable(); }, 120, f.env);
  assert.equal(out.result.you.state, "queued");
  assert.equal(out.waitedMs, 120_000);
  assert.equal(f.logs.length, 1);
});

test("a refusal (4xx) ends the wait at once with its error", async () => {
  for (const status of [400, 403, 404, 409]) {
    const f = fake();
    let polls = 0;
    await assert.rejects(
      waitForLease(answer("queued"), async () => { polls++; throw http(status); }, 1800, f.env),
      (err: unknown) => err instanceof AgentClientError && err.status === status,
    );
    assert.equal(polls, 1);
    assert.equal(f.elapsed(), POLL_FAST_MS);
  }
});

test("only timeouts, connection errors and 5xx count as transient", () => {
  assert.ok(isTransient(timeout()) && isTransient(unreachable()) && isTransient(http(502)));
  assert.ok(!isTransient(http(403)) && !isTransient(http(404)));
  assert.ok(!isTransient(new AgentClientError("bad", { kind: "validation", code: "invalid_request" })));
  assert.ok(!isTransient(new Error("boom")));
});

test("a --wait above the maximum is reported with the cap and capped; one within it is silent", () => {
  const said: string[] = [];
  assert.equal(waitSeconds("1800", (l) => said.push(l)), 1800);
  assert.equal(waitSeconds(String(MAX_WAIT_SECONDS), (l) => said.push(l)), MAX_WAIT_SECONDS);
  assert.equal(said.length, 0);
  assert.equal(waitSeconds("99999", (l) => said.push(l)), MAX_WAIT_SECONDS);
  assert.equal(said.length, 1);
  assert.match(said[0] ?? "", /--wait 99999 is capped at 7200 s/);
  assert.equal(waitSeconds("-5", (l) => said.push(l)), 0);
  assert.equal(waitSeconds("abc", (l) => said.push(l)), 0);
  assert.equal(said.length, 1);
});
