import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoSubmissions, LEDGER_PREVIEW, startDemo } from "../scripts/demo.ts";

test("demo illustrations are purpose-made PNGs and the preview promises only static behavior", () => {
  const submissions = demoSubmissions("http://localhost:12345/");
  assert.deepEqual(submissions.map((s) => s.project?.name), ["Lantern", "Pocket ledger", "Pebble"]);
  const evidence = submissions.flatMap((s) => s.item.evidence ?? []);
  assert.equal(evidence.length, 5);
  for (const e of evidence) {
    assert.equal(typeof e.path, "string");
    const bytes = readFileSync(e.path!);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(e.path!.endsWith(".png"));
  }
  assert.match(LEDGER_PREVIEW, /Static fictional/);
  assert.match(submissions[1]!.item.check!, /Market basket.*Food/);
  const preview = submissions[1]!.item.preview;
  assert.ok(preview && typeof preview !== "string");
  assert.match(preview.setup!, /No drag-and-drop/);
});

test("demo starts its own isolated office, ignores live settings, and removes its database on close", { timeout: 20_000 }, async (t) => {
  const other = mkdtempSync(join(tmpdir(), "demo-parent-data-"));
  const sentinel = join(other, "inbox.sqlite");
  writeFileSync(sentinel, "must not touch this existing database");
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const keys = { INBOX_DATA_DIR: other, INBOX_PORT: "4870", INBOX_URL: "http://localhost:4870", INBOX_CODEX_ACCOUNT_POLLING: "1", INBOX_PRESENCE_DISCOVERY: "1", INBOX_BROWSER_CLEANUP: "1" };
  const before = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  Object.assign(process.env, keys);
  t.after(() => { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const demo = await startDemo({ log: () => {} });
  t.after(() => demo.close());
  assert.notEqual(new URL(demo.url).port, "4870");
  assert.notEqual(new URL(demo.previewUrl).port, "4870");
  assert.ok(demo.dir.startsWith(demo.home));
  assert.notEqual(demo.dir, other);
  assert.ok(existsSync(join(demo.dir, "inbox.sqlite")));
  const state = await (await fetch(`${demo.url}/api/state`)).json();
  assert.equal(state.herdr, "unavailable");
  assert.equal(state.items.length, 3);
  assert.equal(await (await fetch(demo.previewUrl)).text(), LEDGER_PREVIEW);
  assert.equal(readFileSync(sentinel, "utf8"), "must not touch this existing database");
  await demo.close();
  assert.equal(existsSync(demo.home), false);
});

test("demo refuses the live office port before any side effects", async () => {
  await assert.rejects(startDemo({ officePort: 4870 }), /never use/);
  await assert.rejects(startDemo({ previewPort: 4870 }), /never use/);
});
