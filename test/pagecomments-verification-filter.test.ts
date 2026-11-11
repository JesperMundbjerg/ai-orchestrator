import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { PageComments } from "../src/server/pagecomments.ts";
import { World, type LiveAgent } from "../src/server/world.ts";

let nextPort = 49_000 + Math.floor(Math.random() * 900);

async function office(fn: (o: { base: string; world: World; typed: string[]; dir: string; comments: PageComments; setLive: (next: LiveAgent[]) => void }) => Promise<void>, initial: LiveAgent[]) {
  let live = initial;
  const dir = mkdtempSync(join(tmpdir(), "inbox-pagecomments-"));
  const ui = join(dir, "dist");
  mkdirSync(join(ui, "embed"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(ui, "embed", "comment.html"), "<!doctype html><title>Comment to a team</title>");
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const typed: string[] = [];
  const none = async () => { throw new Error("not in this test"); };
  const world = new World(db, {
    available: () => true, live: () => live, prompt: async (pane, text) => void typed.push(`${pane}: ${text}`), notify: async () => {},
    createWorktree: none, startAgent: none, closePane: none, removeWorktree: none,
  }, () => inbox.state());
  world.messages.uploads = inbox.uploads;
  const pageComments = new PageComments(db, {
    state: () => world.state(), instruct: (id, input) => world.messages.instruct(id, input),
    message: (id) => world.messages.message(id), resolve: (session) => world.resolve({ ...session, cwd: session.cwd ?? undefined }),
  }, join(dir, "page-comments.json"));
  // A port another process holds is skipped (the service's host check needs the port up front).
  let server!: ReturnType<typeof createInboxServer>;
  for (let tries = 0; ; tries++) {
    const port = nextPort++;
    server = createInboxServer(inbox, null, { port, staticDir: ui, world, pageComments });
    const listening = server;
    const ok = await new Promise<boolean>((resolve) => {
      listening.once("error", (err: NodeJS.ErrnoException) => { if (err.code === "EADDRINUSE" && tries < 20) resolve(false); else throw err; });
      listening.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) break;
  }
  try {
    await fn({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, world, typed, dir, comments: pageComments, setLive: (next) => void (live = next) });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const live: LiveAgent[] = [
  { paneId: "p1", harness: "pi", sessionId: "s1", cwd: "/lead", status: "idle", title: null, name: null },
];

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Three fixed comments (one per check state; still-wrong as stored before it reopened comments), one still open, one declined, and that legacy follow-up. */
async function seed(world: World, comments: PageComments, base: string) {
  const team = await world.createTeam({ name: "Dispatch", standing: true });
  const lead = world.state().agents.find((a) => a.cwd === "/lead")!;
  world.updateAgent(lead.id, { teamId: team.id, role: "lead" });
  const fixed = (text: string) => comments.setStatus(comments.enqueue(team.id, { text }).id, { status: "fixed", note: "Fixed it" });
  const none = fixed("none"), verified = fixed("verified"), wrong = fixed("wrong");
  const open = comments.enqueue(team.id, { text: "open" });
  const declined = comments.setStatus(comments.enqueue(team.id, { text: "declined" }).id, { status: "declined", note: "no" });
  await fetch(`${base}/api/page-comments/${verified.id}/verify`, json({ verdict: "verified" }));
  // Still wrong reopens a comment now; a fixed comment with that verdict is one judged before that (with its follow-up).
  comments.enqueue(team.id, { text: "still off", followsUp: wrong.id, clientId: `still-wrong:${wrong.id}` });
  (comments as unknown as { db: { prepare(sql: string): { run(...a: string[]): void } } }).db
    .prepare("UPDATE page_comments SET verification = 'still-wrong', verified_at = ? WHERE id = ?").run(new Date().toISOString(), wrong.id);
  const ids = async (q: string) => {
    const res = await fetch(`${base}/api/page-comments?team=${team.id}&${q}`);
    return { status: res.status, ids: res.ok ? ((await res.json()).comments as Array<{ id: string }>).map((c) => c.id).sort() : [], body: res.ok ? null : await res.json() };
  };
  return { none: none.id, verified: verified.id, wrong: wrong.id, open: open.id, declined: declined.id, ids };
}

test("verification selects fixed comments by the founder's check: none, verified or still-wrong", async () => {
  await office(async ({ base, world, comments }) => {
    const s = await seed(world, comments, base);
    assert.deepEqual((await s.ids("verification=none")).ids, [s.none], "fixed and not judged yet; open, declined and follow-ups are not fixed");
    assert.deepEqual((await s.ids("verification=verified")).ids, [s.verified]);
    assert.deepEqual((await s.ids("verification=still-wrong")).ids, [s.wrong]);
  }, live);
});

test("verification takes a comma list, in any order, with repeats and spaces tolerated", async () => {
  await office(async ({ base, world, comments }) => {
    const s = await seed(world, comments, base);
    assert.deepEqual((await s.ids("verification=none,still-wrong")).ids, [s.none, s.wrong].sort());
    assert.deepEqual((await s.ids("verification=still-wrong,none,none")).ids, [s.none, s.wrong].sort());
    assert.deepEqual((await s.ids("verification=none,verified,still-wrong")).ids, [s.none, s.verified, s.wrong].sort());
    assert.deepEqual((await s.ids("verification=verified,%20none")).ids, [s.none, s.verified].sort());
  }, live);
});

test("verification combines with the other filters", async () => {
  await office(async ({ base, world, comments }) => {
    const s = await seed(world, comments, base);
    assert.equal((await s.ids("verification=none,verified&limit=1")).ids.length, 1);
    assert.deepEqual((await s.ids("verification=none&status=declined")).ids, [], "status still narrows");
  }, live);
});

test("verified=true|false keeps meaning what it did", async () => {
  await office(async ({ base, world, comments }) => {
    const s = await seed(world, comments, base);
    assert.deepEqual((await s.ids("verified=true")).ids, [s.verified]);
    assert.deepEqual((await s.ids("verified=false")).ids, [s.none, s.wrong].sort(), "still-wrong counts as not verified");
    assert.equal((await s.ids("")).ids.length, 6, "no filter lists everything");
  }, live);
});

test("verified together with verification is refused rather than guessed", async () => {
  await office(async ({ base, world, comments }) => {
    const s = await seed(world, comments, base);
    for (const q of ["verified=true&verification=verified", "verification=none&verified=false"]) {
      const r = await s.ids(q);
      assert.equal(r.status, 400, q);
      assert.match(JSON.stringify(r.body), /either verified.*or verification.*not both/);
    }
  }, live);
});

test("an unknown or empty verification value is refused", async () => {
  await office(async ({ base, world, comments }) => {
    const s = await seed(world, comments, base);
    for (const q of ["verification=maybe", "verification=none,bogus", "verification=", "verification=still_wrong", "verification=none,"]) {
      const r = await s.ids(q);
      assert.equal(r.status, 400, q);
      assert.match(JSON.stringify(r.body), /unknown verification/);
    }
  }, live);
});
