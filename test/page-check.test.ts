import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { inlineProblem, onOfficeServer, ownAppPage } from "../src/shared/pages.ts";
import type { PageCheck, SubmitResult } from "../src/shared/types.ts";

let nextPort = 49_000 + Math.floor(Math.random() * 1000);

/** The office on a random port, and an unrelated app on another that any page may be framed from. */
async function withOffice(fn: (base: string, app: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-page-check-"));
  const inbox = new Inbox(openDatabase(":memory:"), join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const port = nextPort++;
  const office = createInboxServer(inbox, null, { port, staticDir: null });
  const app = createServer((_req, res) => res.end("an app"));
  await Promise.all([[office, port], [app, 0]].map(([s, p]) => new Promise<void>((resolve) => (s as typeof app).listen(p as number, "127.0.0.1", resolve))));
  try {
    await fn(`http://127.0.0.1:${(office.address() as AddressInfo).port}`, `http://127.0.0.1:${(app.address() as AddressInfo).port}`);
  } finally {
    for (const s of [office, app]) {
      s.closeAllConnections();
      s.close();
    }
  }
}

const OFFICE = "http://127.0.0.1:4870";

test("the office's own app is told from the app you built and from the files it serves", () => {
  assert.equal(ownAppPage(`${OFFICE}/#/world`, OFFICE), true);
  assert.equal(ownAppPage(`${OFFICE}/`, OFFICE), true);
  assert.equal(ownAppPage(`${OFFICE}/#/teams`, OFFICE), true);
  // Another name for the same loopback port is the same service.
  assert.equal(ownAppPage("http://localhost:4870/#/world", OFFICE), true);
  assert.equal(ownAppPage("http://[::1]:4870/", OFFICE), true);
  // Other ports, hosts and schemes are somebody else's app.
  assert.equal(ownAppPage("http://127.0.0.1:3000/#/world", OFFICE), false);
  assert.equal(ownAppPage("http://localhost:4871/", OFFICE), false);
  assert.equal(ownAppPage("https://localhost:4870/", OFFICE), false);
  assert.equal(ownAppPage("http://example.com:4870/", OFFICE), false);
  // Files and images the office hands out, and its API, are content, not the app.
  assert.equal(ownAppPage(`${OFFICE}/uploads/abc.png`, OFFICE), false);
  assert.equal(ownAppPage(`${OFFICE}/files/abc-123`, OFFICE), false);
  assert.equal(ownAppPage(`${OFFICE}/api/state`, OFFICE), false);
  assert.equal(ownAppPage("not a url", OFFICE), false);
});

test("anything the office serves is framed without same-origin rights, the app or not", () => {
  assert.equal(onOfficeServer(`${OFFICE}/uploads/abc.png`, OFFICE), true);
  assert.equal(onOfficeServer("http://localhost:4870/files/x", OFFICE), true);
  assert.equal(onOfficeServer("http://127.0.0.1:3000/", OFFICE), false);
  // A public host that merely shares the port is not the office.
  assert.equal(onOfficeServer("http://example.com:4870/", OFFICE), false);
});

test("an agent is told what will not show inline, and nothing when it will", () => {
  assert.match(inlineProblem(`${OFFICE}/#/world`, OFFICE)!, /own page.*Open in a new tab/);
  assert.equal(inlineProblem("http://127.0.0.1:3000/", OFFICE), null);
  assert.equal(inlineProblem(`${OFFICE}/uploads/abc.png`, OFFICE), null);
});

test("the page check reports the office's own page honestly, and leaves others alone", async () => {
  await withOffice(async (base, app) => {
    const submitted = await fetch(`${base}/api/agent/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: { harness: "manual", sessionId: "s1" },
        item: {
          type: "try",
          title: "Walk the office",
          pages: [
            { label: "Office", url: `${base}/#/world` },
            { label: "Same port, other name", url: `${base.replace("127.0.0.1", "localhost")}/#/teams` },
            { label: "Upload", url: `${base}/uploads/none.png` },
            { label: "The app", url: `${app}/` },
          ],
        },
      }),
    });
    const result = (await submitted.json()) as SubmitResult;
    const check = async (n: number) => (await (await fetch(`${base}/api/items/${result.itemId}/pages/${n}/check`)).json()) as PageCheck;

    const [office, alias, upload, other] = [await check(0), await check(1), await check(2), await check(3)];
    assert.deepEqual([office.own, office.framable, office.reachable], [true, false, true]);
    assert.deepEqual([alias.own, alias.framable], [true, false]);
    assert.equal(upload.own, false);
    assert.deepEqual([other.own, other.framable, other.reachable], [false, true, true]);

    // The same two pages are what the submit told the agent about.
    assert.equal(result.warnings?.length, 2);
    assert.ok(result.warnings?.every((w) => /own page/.test(w)));
  });
});

test("a submission whose pages all show inline has no warnings", async () => {
  await withOffice(async (base, app) => {
    const res = await fetch(`${base}/api/agent/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: { harness: "manual", sessionId: "s2" }, item: { type: "try", title: "Walk the app", pages: [`${app}/`] } }),
    });
    assert.equal(((await res.json()) as SubmitResult).warnings, undefined);
  });
});
