// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/leadwatch.browser.mjs
// A unique-port scratch office, temp HOME/data, no live herdr, headless only; always close in finally.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-leadwatch-browser-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const artifacts = process.env.TEST_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), "review-inbox-artifacts-"));
const office = spawn(process.execPath, ["test/fixtures/leadwatch-office.ts"], {
  env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
office.stdout.on("data", (data) => { logs += data; });
office.stderr.on("data", (data) => { logs += data; });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i === 100) throw new Error(`Scratch office did not start: ${logs}`);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mkdir(artifacts, { recursive: true });
  await page.goto(`${url}/#/teams`);
  await page.locator(".stalled-teams").getByText("Mission Control has no lead online; blocking: Cosmology, ECG, you").waitFor();
  await page.locator(".stalled-note").first().waitFor();
  await page.screenshot({ path: join(artifacts, "board-notice.png") });
  await page.goto(`${url}/#/`);
  await page.getByText("Mission Control has no lead online").first().click();
  await page.getByText("Make Kai lead").first().waitFor();
  await page.screenshot({ path: join(artifacts, "inbox-item.png") });
  assert.deepEqual(errors, []);
  console.log(`PASS: board notice and one founder decision with Make Kai lead. ${artifacts}`);
} finally {
  await browser?.close();
  office.kill("SIGTERM");
  await new Promise((resolve) => office.exitCode !== null ? resolve() : office.once("exit", resolve));
  await rm(home, { recursive: true, force: true });
}
