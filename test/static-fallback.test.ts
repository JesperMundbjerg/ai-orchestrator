import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";

const SHELL = "<!doctype html><title>Test UI</title>";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function office(t: TestContext): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "inbox-static-"));
  const ui = join(dir, "dist");
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), SHELL);
  writeFileSync(join(ui, "assets", "index-NEW.js"), "export default 1;");
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const port = await freePort();
  const server = createInboxServer(inbox, null, { port, staticDir: ui });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${port}`;
}

test("a missing asset is a 404, not the app shell a stale tab would reject on MIME type", async (t) => {
  const base = await office(t);
  for (const path of ["/assets/PipelineEditor-OLD.js", "/assets/PipelineEditor-OLD.css", "/assets/nested/gone", "/favicon.ico", "/old.map"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /Test UI/, path);
  }
  const present = await fetch(base + "/assets/index-NEW.js");
  assert.equal(present.status, 200);
  assert.match(present.headers.get("content-type") ?? "", /javascript/);
});

test("a path that cannot be inside the build is also a 404 when it names a file", async (t) => {
  const base = await office(t);
  // fetch() would normalize the dot segments away; send them as written.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    request(base + "/%2e%2e/%2e%2e/etc/passwd.txt", (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject).end();
  });
  assert.equal(status, 404);
});

test("client-side routes still get the app shell", async (t) => {
  const base = await office(t);
  for (const path of ["/", "/some/route", "/teams", "/index.html"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), SHELL, path);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  }
});

test("the app shell is revalidated on every load, hashed assets are not forced to", async (t) => {
  const base = await office(t);
  for (const path of ["/", "/some/route", "/index.html"]) assert.equal((await fetch(base + path)).headers.get("cache-control"), "no-cache", path);
  assert.equal((await fetch(base + "/assets/index-NEW.js")).headers.get("cache-control"), null);
});
