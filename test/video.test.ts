import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import type { EvidenceInput, ItemDetail, ItemType, SubmitInput } from "../src/shared/types.ts";
import reviewInbox from "../integrations/pi/review-inbox.ts";

const exec = promisify(execFile);
const none = { available: () => false, forSession: () => null, resolvePane: () => null };
const submission = (evidence: EvidenceInput[], type: ItemType = "milestone"): SubmitInput => ({
  session: { harness: "manual", sessionId: "video-test" }, item: { type, title: "Animation pass", evidence },
});

async function fixture(run: (f: { dir: string; inbox: Inbox; base: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-video-"));
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), none);
  const port = 51000 + Math.floor(Math.random() * 10000);
  const server = createInboxServer(inbox, null, { port, staticDir: null });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    await run({ dir, inbox, base: `http://127.0.0.1:${port}` });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (base: string, body: SubmitInput) => fetch(`${base}/api/agent/items`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("video evidence is copied, ordered, revision-stable, and counted only at the current revision", async () => {
  await fixture(async ({ dir, inbox }) => {
    const paths = ["first.MP4", "second.webm", "third.mov"].map((name) => join(dir, name));
    paths.forEach((path, i) => writeFileSync(path, `video bytes ${i}`));
    const input = submission(paths.map((path) => ({ path })));
    const first = inbox.submit(input);
    assert.equal(inbox.submit(input).changed, false);
    const evidence = inbox.detail(first.itemId).evidence;
    assert.deepEqual(evidence.map((e) => e.kind), ["video", "video", "video"]);
    assert.equal(inbox.state().items[0]!.videoCount, 3);
    paths.forEach(unlinkSync);
    evidence.forEach((e, i) => assert.equal(readFileSync(inbox.evidenceFile(e.id)!.path, "utf8"), `video bytes ${i}`));
    const revised = inbox.submit(submission([]));
    assert.equal(revised.revision, 2);
    assert.equal(inbox.state().items[0]!.videoCount, 0);
    assert.equal(inbox.detail(first.itemId).evidence.length, 3, "old revision evidence survives");
  });
});

test("agent protocol accepts each video container and refuses bad types, dotfiles, symlinks and oversized evidence", async () => {
  await fixture(async ({ dir, base }) => {
    for (const [ext, mime] of [["mp4", "video/mp4"], ["webm", "video/webm"], ["mov", "video/quicktime"]]) {
      const path = join(dir, `clip.${ext}`);
      writeFileSync(path, `bytes of ${ext}`);
      const res = await post(base, submission([{ path }]));
      assert.equal(res.status, 200);
      const detail: ItemDetail = await (await fetch(`${base}/api/items/${(await res.json()).itemId}`)).json();
      const media = await fetch(`${base}${detail.evidence[0]!.href}`);
      assert.equal(media.headers.get("content-type"), mime);
      assert.equal(await media.text(), `bytes of ${ext}`);
    }
    for (const name of ["clip.avi", "clip.exe", ".secret.mp4"]) {
      const path = join(dir, name);
      writeFileSync(path, "bad");
      const res = await post(base, submission([{ path }]));
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /cannot attach/);
    }
    const link = join(dir, "link.mp4");
    symlinkSync(join(dir, "clip.mp4"), link);
    assert.equal((await post(base, submission([{ path: link }]))).status, 400);
    for (const [name, bytes, message] of [["huge.mp4", 200 * 1024 * 1024 + 1, /larger than 200 MB/], ["huge.png", 20 * 1024 * 1024 + 1, /larger than 20 MB/]] as const) {
      const path = join(dir, name);
      writeFileSync(path, "");
      truncateSync(path, bytes); // Sparse: reject before allocating or copying the video.
      const res = await post(base, submission([{ path }]));
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, message);
    }
    const roomy = join(dir, "above-image-limit.mp4");
    writeFileSync(roomy, "");
    truncateSync(roomy, 20 * 1024 * 1024 + 1);
    assert.equal((await post(base, submission([{ path: roomy }]))).status, 200, "video has its own larger cap");
    const photo = join(dir, "photo.png");
    writeFileSync(photo, "image");
    const wrong = await post(base, submission([{ path: photo, kind: "video" }]));
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /use MP4, WebM or MOV/);
  });
});

test("copied video streams correct full, bounded, open and suffix ranges, with 416 beyond EOF", async () => {
  await fixture(async ({ dir, base, inbox }) => {
    const path = join(dir, "clip.mp4");
    writeFileSync(path, "0123456789");
    const { itemId } = inbox.submit(submission([{ path }]));
    const url = `${base}${inbox.detail(itemId).evidence[0]!.href}`;
    unlinkSync(path); // Requests must use the inbox copy, not the original.
    for (const [range, bytes, contentRange] of [["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=6-", "6789", "bytes 6-9/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=8-99", "89", "bytes 8-9/10"], ["bytes=-99", "0123456789", "bytes 0-9/10"]]) {
      const res = await fetch(url, { headers: { range: range! } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("content-range"), contentRange);
      assert.equal(res.headers.get("content-length"), String(bytes!.length));
      assert.equal(res.headers.get("accept-ranges"), "bytes");
      assert.equal(res.headers.get("content-security-policy"), "sandbox");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await res.text(), bytes);
    }
    for (const range of ["bytes=10-", "bytes=30-40", "bytes=4-2", "bytes=-0"]) {
      const res = await fetch(url, { headers: { range } });
      assert.equal(res.status, 416);
      assert.equal(res.headers.get("content-range"), "bytes */10");
      assert.equal(await res.text(), "");
    }
    for (const headers of [{}, { range: "bytes=0-1,4-5" }, { range: "nonsense" }, { range: "bytes=2-5", "if-range": '"unknown"' }] as Array<Record<string, string>>) {
      const res = await fetch(url, { headers });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "0123456789");
    }
    const head = await fetch(url, { method: "HEAD", headers: { range: "bytes=2-3" } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${base}/files/unknown-id`)).status, 404);
    const unlisted = join(dir, "files", "unlisted.mp4");
    writeFileSync(unlisted, "not submitted");
    assert.equal((await fetch(`${base}/files/unlisted.mp4`)).status, 404);
    assert.equal((await fetch(`${base}/files/%2e%2e%2fclip.mp4`)).status, 404);
    const empty = join(dir, "empty.mp4");
    writeFileSync(empty, "");
    const emptyItem = inbox.submit(submission([{ path: empty }]));
    const emptyRes = await fetch(`${base}${inbox.detail(emptyItem.itemId).evidence[0]!.href}`, { headers: { range: "bytes=0-" } });
    assert.equal(emptyRes.status, 416);
    assert.equal(emptyRes.headers.get("content-range"), "bytes */0");
  });
});

test("CLI --video is repeatable on every review type, preserves mixed evidence order and reports refusal clearly", async () => {
  await fixture(async ({ dir, base, inbox }) => {
    const path = join(dir, "first.mp4");
    const second = join(dir, "second.webm");
    const photo = join(dir, "photo.png");
    writeFileSync(path, "first"); writeFileSync(second, "second"); writeFileSync(photo, "photo");
    const cli = (...args: string[]) => exec(process.execPath, [resolve("bin/inbox"), ...args, "--harness", "manual", "--session", "cli-video"], { env: { ...process.env, INBOX_URL: base } });
    for (const type of ["decide", "try", "milestone"]) {
      const result = await cli(type, `Video ${type}`, "--video", path, "--screenshot", photo, "--video", second);
      assert.match(result.stdout, /Submitted/);
      const item = inbox.state().items.find((i) => i.title === `Video ${type}`)!;
      assert.equal(item.videoCount, 2);
      assert.deepEqual(inbox.detail(item.id).evidence.map((e) => e.kind), ["video", "image", "video"]);
    }
    await assert.rejects(cli("milestone", "Wrong type", "--video", photo), /use MP4, WebM or MOV/);
    truncateSync(path, 200 * 1024 * 1024 + 1);
    await assert.rejects(cli("milestone", "Too large", "--video", path), /larger than 200 MB/);
    const help = await cli("--help");
    assert.match(help.stdout, /--video FILE/);
    assert.match(help.stdout, /200 MB/);
  });
});

test("existing databases gain video support without losing evidence URLs, order or revisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-video-migration-"));
  const file = join(dir, "inbox.db");
  let db = openDatabase(file);
  try {
    const photo = join(dir, "old.png");
    writeFileSync(photo, "old image");
    const inbox = new Inbox(db, join(dir, "files"), none);
    const { itemId } = inbox.submit(submission([{ path: photo, caption: "First" }, { path: photo, caption: "Second" }]));
    const before = inbox.detail(itemId).evidence;
    db.close();
    db = new DatabaseSync(file);
    // Recreate exactly the older constraint, with gaps in rowid to test order preservation.
    const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'evidence'").get() as { sql: string }).sql.replace("'image', 'video',", "'image',");
    db.exec(`ALTER TABLE evidence RENAME TO old_evidence; ${schema};
      INSERT INTO evidence SELECT * FROM old_evidence ORDER BY rowid;
      DROP TABLE old_evidence; UPDATE evidence SET rowid = rowid + 10;`);
    db.close();
    db = openDatabase(file);
    const migrated = new Inbox(db, join(dir, "files"), none);
    assert.deepEqual(migrated.detail(itemId).evidence, before);
    assert.deepEqual(db.prepare("SELECT rowid FROM evidence ORDER BY rowid").all().map((r) => r.rowid), [11, 12]);
    const video = join(dir, "new.mp4");
    writeFileSync(video, "new video");
    assert.equal(migrated.submit(submission([{ path: video }])).revision, 2);
    db.close();
    db = openDatabase(file); // Idempotent migration and retained old attachment URL.
    const reopened = new Inbox(db, join(dir, "files"), none);
    assert.equal(reopened.detail(itemId).evidence.length, 3);
    assert.equal(readFileSync(reopened.evidenceFile(before[0]!.id)!.path, "utf8"), "old image");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi review_submit advertises videos and forwards absolute paths in order alongside screenshots", async (t) => {
  type PiApi = Parameters<typeof reviewInbox>[0];
  const tools: Array<Parameters<PiApi["registerTool"]>[0]> = [];
  const pi = {
    registerTool: (tool: Parameters<PiApi["registerTool"]>[0]) => { tools.push(tool); }, on() {},
    sendUserMessage() {}, getSessionName() { return undefined; },
    getThinkingLevel() { return "off" as const; }, setThinkingLevel() {},
  };
  reviewInbox(pi);
  const tool = tools.find((tool) => tool.name === "review_submit")!;
  assert.ok((tool.parameters as { properties: Record<string, unknown> }).properties.videos);
  let sent: SubmitInput | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
    sent = JSON.parse(String(opts.body));
    return Response.json({ itemId: "item", revision: 1, changed: true });
  });
  await tool.execute("call", { type: "milestone", title: "Animation", screenshots: ["/tmp/photo.png"], videos: ["/tmp/first.mp4", "/tmp/second.mov"] }, undefined, undefined, {
    cwd: tmpdir(), sessionManager: { getSessionFile: () => "/tmp/session.jsonl" }, isIdle: () => true,
  });
  assert.deepEqual(sent!.item.evidence, [{ path: "/tmp/photo.png" }, { path: "/tmp/first.mp4", kind: "video" }, { path: "/tmp/second.mov", kind: "video" }]);
});
