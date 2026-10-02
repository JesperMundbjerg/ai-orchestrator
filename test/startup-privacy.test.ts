import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIntegrations, startupConfig, STARTUP_KEYS } from "../src/server/startup-config.ts";
import { Usage, ACCOUNT_EVERY_MS } from "../src/server/usage.ts";
import { FOUNDER_INTEGRATIONS } from "../scripts/restart-office.ts";

test("startup integrations default off and opt in independently", () => {
  assert.deepEqual(startupConfig({}), { codexAccountPolling: false, presenceDiscovery: false, browserCleanup: false });
  for (const [name, key] of Object.entries(STARTUP_KEYS)) {
    const config = startupConfig({ [key]: "true" });
    const calls: string[] = [];
    startIntegrations(config, {
      herdr: { start: () => { calls.push("presenceDiscovery"); } },
      machine: { start: () => { calls.push("browserCleanup"); } },
      usage: { start: ({ accountPolling }) => { if (accountPolling) calls.push("codexAccountPolling"); } },
    });
    assert.deepEqual(calls, [name]);
    assert.equal(startupConfig({ [key]: "0" })[name as keyof typeof config], false);
    assert.throws(() => startupConfig({ [key]: "maybe" }), /must be/);
  }
  assert.deepEqual(startupConfig(FOUNDER_INTEGRATIONS), { codexAccountPolling: true, presenceDiscovery: true, browserCleanup: true });
});

test("Usage startup does not read the Codex account by default; opt-in polls and stop cancels", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "usage-privacy-"));
  const db = new DatabaseSync(":memory:");
  const usage = new Usage(db, () => new Date(), { claude: dir, codex: dir, pi: dir, claudeJson: join(dir, "missing") });
  t.after(() => { usage.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  let accountReads = 0;
  t.mock.method(usage, "readAccount", async () => { accountReads++; return false; });
  usage.start();
  t.mock.timers.tick(ACCOUNT_EVERY_MS);
  assert.equal(accountReads, 0);
  usage.start({ accountPolling: true });
  assert.equal(accountReads, 1);
  t.mock.timers.tick(ACCOUNT_EVERY_MS);
  assert.equal(accountReads, 2);
  usage.stop();
  t.mock.timers.tick(ACCOUNT_EVERY_MS);
  assert.equal(accountReads, 2);
});
