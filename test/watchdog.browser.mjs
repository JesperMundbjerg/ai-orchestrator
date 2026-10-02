// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/watchdog.browser.mjs
// A unique-port scratch office, temp HOME/data, no live herdr, headless only; always close in finally.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-watchdog-browser-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const artifacts = process.env.TEST_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), "review-inbox-artifacts-"));
const screenshot = join(artifacts, "watchdog.png");
const office = spawn(process.execPath, ["test/fixtures/watchdog-office.ts"], {
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
  const world = await (await fetch(`${url}/api/world`)).json();
  const notice = world.withFounder.find((m) => m.fromOffice);
  assert.equal(notice.text, "Heron (Review Inbox) is free but 2 messages have waited 12 minutes undelivered.");
  // Two queued messages and one sending message: only queued messages count.
  assert.equal(notice.deliveries.length, 0);
  assert.match(logs, /messages undelivered/);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}/#/world`);
  await page.getByRole("button", { name: /^Review Inbox Idle/ }).click();
  await page.locator("button.member").filter({ hasText: "Heron" }).click();
  const thread = page.getByRole("list", { name: "You and Heron" });
  await thread.getByText(notice.text, { exact: true }).waitFor();
  await thread.locator(".say-head").filter({ hasText: "The office notice to you" }).waitFor();
  assert.equal(await thread.locator(".say.you").filter({ hasText: notice.text }).count(), 0, "office notice must not look like a founder message");
  await thread.getByText(/The transport check is ready/).waitFor();
  await mkdir(join(screenshot, ".."), { recursive: true });
  await page.screenshot({ path: screenshot });
  assert.deepEqual(errors, []);
  console.log(`PASS: office notice alongside agent's answer, clearly from The office; desktop notice sent. ${screenshot}`);
} finally {
  await browser?.close();
  office.kill("SIGTERM");
  await new Promise((resolve) => office.exitCode !== null ? resolve() : office.once("exit", resolve));
  await rm(home, { recursive: true, force: true });
}
