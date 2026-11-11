import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { PageComments } from "../src/server/pagecomments.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { acceptEmbedMessage, normalizeOriginPattern, pageCommentText, pageOriginAllowed, DEFAULT_PAGE_ORIGINS } from "../src/shared/pagecomments.ts";

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
  { paneId: "p2", harness: "pi", sessionId: "s2", cwd: "/crew", status: "idle", title: null, name: null },
];

async function seat(world: World) {
  const team = await world.createTeam({ name: "Dispatch", standing: true, purpose: "Routes review comments" });
  const empty = await world.createTeam({ name: "Atlas", standing: true });
  const [lead, crew] = ["/lead", "/crew"].map((cwd) => world.state().agents.find((a) => a.cwd === cwd)!);
  world.updateAgent(lead!.id, { teamId: team.id, role: "lead" });
  world.updateAgent(crew!.id, { teamId: team.id, role: "member" });
  return { team, empty, lead: world.state().agents.find((a) => a.id === lead!.id)! };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); };

test("a page lists every team by id with its purpose, status and whether its lead is present", async () => {
  await office(async ({ base, world }) => {
    const { team, empty, lead } = await seat(world);
    const { teams } = await (await fetch(`${base}/api/page-comments/teams`)).json();
    assert.deepEqual(teams, [
      { id: empty.id, name: "Atlas", purpose: "", status: teams[0].status, lead: null, leadPresent: false },
      { id: team.id, name: "Dispatch", purpose: "Routes review comments", status: teams[1].status, lead: { name: lead.name, online: true }, leadPresent: true },
    ]);
    for (const t of teams) assert.ok(["blocked", "working", "idle", "offline"].includes(t.status));
    assert.ok(!JSON.stringify(teams).includes("/lead"), "no checkout paths reach a page");
  }, live);
});

test("a page comment reaches the team's lead once, as a founder message with the page context on top", async () => {
  await office(async ({ base, world, typed }) => {
    const { team, lead } = await seat(world);
    const body = {
      text: "The button overlaps the chart on phones.", clientId: "page-1",
      page: { url: "http://localhost:3000/lessons/orbits#chart", title: "Orbits", selector: "main .chart > button", anchor: "chart", selectedText: "Launch", viewport: "390x844 phone", secret: "dropped" },
    };
    const res = await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json(body));
    assert.equal(res.status, 200);
    const sent = await res.json();
    assert.equal(sent.teamId, team.id);
    assert.equal(sent.teamName, "Dispatch");
    await until(() => typed.length > 0);
    assert.equal(typed.length, 1, "typed to one agent");
    const [pane, ...rest] = typed[0]!.split(": ");
    assert.equal(pane, "p1", "the lead's pane, not the crew's");
    const prompt = rest.join(": ");
    assert.match(prompt, /^\[From the founder to Dispatch\]/);
    assert.match(prompt, new RegExp(`Page comment ${sent.id}\\. Say \`inbox comment working ${sent.id}\``), "the lead is told the id and the command");
    assert.match(prompt, /\[Page comment\]\nOn "Orbits" http:\/\/localhost:3000\/lessons\/orbits#chart\nAt: element main \.chart > button · #chart · viewport 390x844 phone\nSelected: "Launch"\n\nThe button overlaps the chart on phones\./);
    assert.ok(!prompt.includes("dropped"), "unknown context fields are not passed on");
    const messages = world.messages.withFounder().filter((m) => m.teamId === team.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.kind, "instruction");
    assert.equal(messages[0]!.fromAgentId, null, "from the founder");
    assert.deepEqual(messages[0]!.deliveries.map((d) => d.agentId), [lead.id]);

    // A retry with the same client id answers the same message and types nothing again.
    const again = await (await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json(body))).json();
    assert.equal(again.id, sent.id);
    assert.equal(again.messageId, sent.messageId);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(typed.length, 1);
    assert.equal(world.messages.withFounder().filter((m) => m.teamId === team.id).length, 1);
    // Reusing the client id for a different comment is a conflict, not a silent drop.
    assert.equal((await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ ...body, text: "Something else" }))).status, 409);
  }, live);
});

test("a comment names a team by id; an unknown id or an empty comment is refused", async () => {
  await office(async ({ base, world }) => {
    await seat(world);
    assert.equal((await fetch(`${base}/api/page-comments/teams/Dispatch/comments`, json({ text: "hi" }))).status, 404, "not by name");
    const { teams } = await (await fetch(`${base}/api/page-comments/teams`)).json();
    assert.equal((await fetch(`${base}/api/page-comments/teams/${teams[1].id}/comments`, json({ text: "  ", page: { title: "x" } }))).status, 400);
  }, live);
});

test("cross-origin calls to the page-comment API are still refused; a backend without an Origin works", async () => {
  await office(async ({ base, world, typed }) => {
    const { team } = await seat(world);
    const cross = await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "hi" }, { origin: "http://localhost:3000" }));
    assert.equal(cross.status, 403, "even an allowed page origin cannot call the API directly");
    const origins = await fetch(`${base}/api/page-comments/origins`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ origins: ["https://evil.example"] }) });
    assert.equal(origins.status, 403, "no page can widen its own allowlist");
    assert.equal(typed.length, 0);
    const own = await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "hi" }, { origin: base }));
    assert.equal(own.status, 200, "the widget's same-origin request");
    assert.equal((await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "from a backend" }))).status, 200);
  }, live);
});

test("the widget is served from the office, framable only by allowed page origins", async () => {
  await office(async ({ base }) => {
    const res = await fetch(`${base}/embed/comment`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /Comment to a team/);
    assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*");
    const saved = await fetch(`${base}/api/page-comments/origins`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ origins: ["https://Lessons.example/", "http://localhost:3000"] }) });
    assert.deepEqual(await saved.json(), { origins: ["https://lessons.example", "http://localhost:3000"], default: false });
    assert.equal((await fetch(`${base}/embed/comment.html`)).headers.get("content-security-policy"), "frame-ancestors 'self' https://lessons.example http://localhost:3000");
    assert.equal((await fetch(`${base}/api/page-comments/origins`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ origins: ["javascript:alert(1)"] }) })).status, 400);
  }, []);
});

test("a host page's postMessage origin is checked against the allowlist", () => {
  const allow = ["http://localhost:*", "https://lessons.example", "http://127.0.0.1:5173"];
  assert.equal(pageOriginAllowed("http://localhost:3000", allow), true);
  assert.equal(pageOriginAllowed("http://localhost", allow), true, "* also matches no port");
  assert.equal(pageOriginAllowed("https://lessons.example", allow), true);
  assert.equal(pageOriginAllowed("http://127.0.0.1:5173", allow), true);
  for (const refused of [
    "http://127.0.0.1:5174", "https://localhost:3000", "http://lessons.example", "https://lessons.example:8443",
    "https://evil-lessons.example", "https://lessons.example.evil.test", "http://localhost.evil.test:3000",
    "null", "", "file://", "http://localhost:3000/path",
  ]) assert.equal(pageOriginAllowed(refused, allow), false, refused);
  assert.equal(pageOriginAllowed("http://localhost:3000", []), false);
  assert.deepEqual([...DEFAULT_PAGE_ORIGINS], ["http://localhost:*", "http://127.0.0.1:*"]);
  assert.equal(normalizeOriginPattern("HTTPS://Example.com/"), "https://example.com");
  for (const bad of ["*", "https://*.example.com", "ftp://x", "https://x/path", "http://x:0", "http://x:99999"]) assert.equal(normalizeOriginPattern(bad), null, bad);
});

test("the widget takes page context only from an allowed origin and only about that page", () => {
  const allow = ["http://localhost:*"];
  const msg = { type: "office-comment:context", version: 1, page: { url: "http://localhost:3000/a", title: " A\n page ", selector: "#x" }, defaultTeamId: "t1", screenshots: ["data:image/png;base64,AAAA", "javascript:x"] };
  assert.deepEqual(acceptEmbedMessage("http://localhost:3000", { ...msg, openUrl: "http://localhost:3000/a?step=2", meta: { lesson: "a", step: 2 } }, allow), {
    type: "context", page: { url: "http://localhost:3000/a", title: "A page", selector: "#x" }, openUrl: "http://localhost:3000/a?step=2", meta: { lesson: "a", step: 2 },
    defaultTeamId: "t1", screenshots: ["data:image/png;base64,AAAA"],
  });
  const foreign = acceptEmbedMessage("http://localhost:3000", { ...msg, openUrl: "https://bank.example/", meta: { big: "x".repeat(3000) } }, allow);
  assert.equal(foreign?.type === "context" && (foreign.openUrl ?? foreign.meta), undefined, "an openUrl elsewhere and oversized meta are dropped");
  assert.deepEqual(acceptEmbedMessage("http://localhost:3000", { type: "office-comment:watch", version: 1, ids: ["pc-0123456789", "nope"] }, allow), { type: "watch", ids: ["pc-0123456789"] });
  assert.equal(acceptEmbedMessage("https://evil.example", { type: "office-comment:watch", version: 1 }, allow), null);
  assert.equal(acceptEmbedMessage("https://evil.example", msg, allow), null);
  assert.equal(acceptEmbedMessage("http://localhost:3000", { ...msg, version: 2 }, allow), null);
  assert.equal(acceptEmbedMessage("http://localhost:3000", "hello", allow), null);
  const other = acceptEmbedMessage("http://localhost:3000", { ...msg, page: { url: "https://bank.example/" } }, allow);
  assert.deepEqual(other?.type === "context" ? other.page : null, {}, "a url on another origin than the sender's is dropped");
  assert.equal(pageCommentText("hi", {}), "[Page comment]\n\nhi");
});

const sse = (url: string) => {
  const controller = new AbortController();
  const events: Array<Record<string, unknown>> = [];
  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (block.includes("event: comment") && data) events.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch(() => {});
  return { events, close: async () => { controller.abort(); await done; } };
};

test("a comment goes queued → delivered → working → fixed; the fixer's url overrides openUrl and the stream says so", async () => {
  await office(async ({ base, world, typed, comments }) => {
    const { team } = await seat(world);
    const sent = await (await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({
      text: "Step 2 explains the focus wrongly.", clientId: "c-1",
      page: { url: "http://localhost:3000/lessons/orbits", title: "Orbits" },
      openUrl: "http://localhost:3000/lessons/orbits?step=2", meta: { lesson: "orbits", step: 2 },
    }))).json();
    assert.equal(sent.origin, "http://localhost:3000");
    assert.equal(sent.openUrl, "http://localhost:3000/lessons/orbits?step=2");
    assert.deepEqual(sent.meta, { lesson: "orbits", step: 2 });
    const stream = sse(`${base}/api/page-comments/events?origin=http://localhost:3000`);
    try {
      await until(() => typed.length > 0);
      assert.match(typed[0]!, /Open to check: http:\/\/localhost:3000\/lessons\/orbits\?step=2/);
      // The delivery ends once the agent takes the prompt up; the office reads it on its next sync.
      await until(() => (comments.sync(), comments.get(sent.id).status === "delivered"));
      assert.equal(comments.get(sent.id).status, "delivered");
      const status = (body: unknown) => fetch(`${base}/api/page-comments/${sent.id}/status`, json(body));
      assert.equal((await status({ status: "declined" })).status, 400, "declining needs a note");
      assert.equal((await status({ status: "working" })).status, 200);
      const fixed = await (await status({ status: "fixed", url: "http://localhost:3000/lessons/orbits?step=2#focus", note: "Reworded", commit: "ABC1234" })).json();
      assert.equal(fixed.status, "fixed");
      assert.equal(fixed.openUrl, "http://localhost:3000/lessons/orbits?step=2#focus", "the fixer's url wins");
      assert.equal(fixed.commit, "abc1234");
      assert.equal((await status({ status: "declined", note: "changed my mind" })).status, 409, "a closed comment stays closed");
      assert.equal((await status({ status: "fixed", note: "Reworded" })).status, 200, "repeating the same close is fine");
      await until(() => stream.events.some((e) => e.status === "fixed"));
      const seen = stream.events.filter((e) => e.id === sent.id).map((e) => e.status);
      assert.deepEqual(seen.slice(seen.indexOf("delivered")), ["delivered", "working", "fixed"], `the stream's order: ${seen.join(", ")}`);
      const last = stream.events.at(-1)!;
      assert.deepEqual(last, {
        id: sent.id, teamId: team.id, teamName: "Dispatch", groupId: null, status: "fixed", text: "Step 2 explains the focus wrongly.", kind: null,
        openUrl: "http://localhost:3000/lessons/orbits?step=2#focus", note: "Reworded", commit: "abc1234", question: null, answer: null, by: null,
        revision: 0, editable: false, followsUp: null, followUps: [], verification: null, verifiedAt: null, history: [], releasedWithout: null,
        meta: { lesson: "orbits", step: 2 }, fixedAt: last.updatedAt, updatedAt: last.updatedAt,
      }, "the event carries everything a page shows");
      assert.equal((await (await fetch(`${base}/api/page-comments/${sent.id}`)).json()).status, "fixed");
      assert.equal((await (await fetch(`${base}/api/page-comments?team=${team.id}`)).json()).comments.length, 1);
    } finally { await stream.close(); }
    // Another origin's stream hears nothing of it.
    const other = sse(`${base}/api/page-comments/events?origin=http://localhost:4000`);
    await new Promise((r) => setTimeout(r, 100));
    await other.close();
    assert.equal(other.events.length, 0);
  }, live);
});

test("a comment for a lead who is away waits in the office's queue and is delivered when they are back", async () => {
  await office(async ({ base, world, typed, comments, setLive }) => {
    const { team } = await seat(world);
    setLive([live[1]!]);
    await world.react();
    const sent = await (await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "Away test", clientId: "away-1" }))).json();
    await new Promise((r) => setTimeout(r, 100));
    comments.sync();
    assert.equal(comments.get(sent.id).status, "queued");
    assert.equal(typed.filter((t) => t.includes("Away test")).length, 0, "nothing is typed while the lead is away");
    setLive(live);
    await world.react();
    await until(() => typed.some((t) => t.includes("Away test")));
    assert.equal(typed.filter((t) => t.startsWith("p1: ") && t.includes("Away test")).length, 1, "typed once, to the lead, when back");
    await until(() => (comments.sync(), comments.get(sent.id).status === "delivered"));
    assert.equal(comments.get(sent.id).status, "delivered");
    // A team with nobody on it keeps the comment queued, and delivers it once someone leads.
    const empty = await world.createTeam({ name: "Later", standing: true });
    const waiting = comments.enqueue(empty.id, { text: "For later" });
    assert.equal(waiting.status, "queued");
    assert.match(waiting.note ?? "", /nobody is on Later yet/);
    world.updateAgent(world.state().agents.find((a) => a.cwd === "/crew")!.id, { teamId: empty.id, role: "lead" });
    comments.sync();
    await until(() => typed.some((t) => t.includes("For later")));
    assert.ok(typed.some((t) => t.startsWith("p2: ") && t.includes("For later")));
  }, live);
});

test("`inbox comment fixed` closes a comment as the agent running it, with its url, note and commit", async () => {
  await office(async ({ base, world, comments }) => {
    const { team, lead } = await seat(world);
    const sent = comments.enqueue(team.id, { text: "CLI test", openUrl: "http://localhost:3000/a" });
    const run = (...args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, INBOX_URL: base };
      for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "HERDR_PANE_ID"]) delete env[k];
      execFile(process.execPath, ["bin/inbox", ...args], { env }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
    });
    const declined = await run("comment", "declined", sent.id, "--harness", "pi", "--session", "s1");
    assert.notEqual(declined.code, 0);
    assert.match(declined.out, /say why/);
    const noNote = await run("comment", "fixed", sent.id, "--commit", "0123abc", "--harness", "pi", "--session", "s1");
    assert.notEqual(noNote.code, 0);
    assert.match(noNote.out, /--note/);
    const tooLong = await run("comment", "fixed", sent.id, "--commit", "0123abc", "--note", "x".repeat(121), "--harness", "pi", "--session", "s1");
    assert.notEqual(tooLong.code, 0);
    assert.match(tooLong.out, /120/);
    assert.equal(comments.get(sent.id).status, "delivered", "refused closes change nothing");
    const fixed = await run("comment", "fixed", sent.id, "--url", "http://localhost:3000/a?step=3", "--note", "Moved the label", "--commit", "0123abc", "--harness", "pi", "--session", "s1");
    assert.equal(fixed.code, 0, fixed.out);
    assert.match(fixed.out, new RegExp(`Comment ${sent.id} to Dispatch: fixed \\(Moved the label\\)`));
    const after = comments.get(sent.id);
    assert.equal(after.status, "fixed");
    assert.equal(after.openUrl, "http://localhost:3000/a?step=3");
    assert.equal(after.commit, "0123abc");
    assert.equal(after.by, lead.name);
    const shown = await run("comment", "show", sent.id);
    assert.match(shown.out, /open: http:\/\/localhost:3000\/a\?step=3/);
  }, live);
});

const typedFor = (typed: string[], needle: string) => typed.filter((t) => t.includes(needle));

test("a held group changes in place until it is sent, then reaches the lead as one message; each comment keeps its own id and status", async () => {
  await office(async ({ base, world, typed, comments }) => {
    const { team, empty } = await seat(world);
    const add = async (body: Record<string, unknown>) => (await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json(body))).json();
    const page = { url: "http://localhost:3000/lessons/orbits", title: "Orbits" };
    const first = await add({ text: "Axis labels are missing.", kind: "bug", hold: true, page });
    assert.equal(first.status, "held");
    assert.equal(first.editable, true);
    assert.match(first.groupId, /^pg-[0-9a-f]{10}$/);
    const second = await add({ text: "The caption is long-winded.", kind: "copy", hold: true, groupId: first.groupId, page });
    const third = await add({ text: "Maybe animate it?", hold: true, groupId: first.groupId, page });
    assert.equal(second.groupId, first.groupId);
    // A group goes to one team.
    assert.equal((await fetch(`${base}/api/page-comments/teams/${empty.id}/comments`, json({ text: "x", hold: true, groupId: first.groupId }))).status, 409);

    // Before it is sent, an edit and a withdraw change the office's copy; the lead hears nothing.
    const edited = await (await fetch(`${base}/api/page-comments/${second.id}/edit`, json({ text: "The caption is too long.", kind: "copy" }))).json();
    assert.equal(edited.text, "The caption is too long.");
    assert.equal(edited.revision, 1);
    assert.equal(edited.status, "held");
    assert.equal((await (await fetch(`${base}/api/page-comments/${third.id}/withdraw`, json({}))).json()).status, "withdrawn");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(typed.length, 0, "nothing reaches the lead while the group is held");
    assert.equal((await fetch(`${base}/api/page-comments/${first.id}/status`, json({ status: "working" }))).status, 409, "the lead cannot mark what it has not been given");

    const sent = await (await fetch(`${base}/api/page-comments/groups/${first.groupId}/send`, json({}))).json();
    assert.deepEqual(sent.comments.map((c: { id: string; status: string }) => [c.id, c.status]), [[first.id, "queued"], [second.id, "queued"], [third.id, "withdrawn"]]);
    await until(() => typed.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(typed.length, 1, "one message for the group");
    const prompt = typed[0]!;
    assert.match(prompt, new RegExp(`\\[Page comments: 2 in group ${first.groupId}\\]`));
    assert.match(prompt, new RegExp(`1\\. Page comment ${first.id} · bug\\nOn "Orbits" http://localhost:3000/lessons/orbits\\n\\nAxis labels are missing\\.`));
    assert.match(prompt, new RegExp(`2\\. Page comment ${second.id} · copy[^]*The caption is too long\\.`));
    assert.ok(!prompt.includes("long-winded") && !prompt.includes("animate"), "the edited text, and not the withdrawn comment");
    assert.equal(comments.get(first.id).messageId, comments.get(second.id).messageId);
    await until(() => (comments.sync(), comments.get(second.id).status === "delivered"));
    assert.equal(comments.get(first.id).status, "delivered");
    // Each has its own status from here on.
    assert.equal((await (await fetch(`${base}/api/page-comments/${first.id}/status`, json({ status: "fixed", note: "Labelled" }))).json()).status, "fixed");
    assert.equal(comments.get(second.id).status, "delivered");
    assert.equal(comments.get(third.id).status, "withdrawn");
    // A sent group takes no more comments.
    assert.equal((await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "late", hold: true, groupId: first.groupId }))).status, 409);

    // Discarding a held group withdraws its comments without anyone hearing.
    const other = await add({ text: "Never mind", hold: true });
    const discarded = await (await fetch(`${base}/api/page-comments/groups/${other.groupId}/discard`, json({}))).json();
    assert.deepEqual(discarded.comments.map((c: { status: string }) => c.status), ["withdrawn"]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(typedFor(typed, "Never mind").length, 0);
  }, live);
});

test("a batch of comments is queued as one group in one call, replay-safe with a client id", async () => {
  await office(async ({ base, world, typed }) => {
    const { team } = await seat(world);
    const body = { clientId: "batch-1", comments: [{ text: "One", kind: "idea" }, { text: "Two", openUrl: "http://localhost:3000/b" }] };
    const out = await (await fetch(`${base}/api/page-comments/teams/${team.id}/groups`, json(body))).json();
    assert.equal(out.comments.length, 2);
    assert.ok(out.comments.every((c: { groupId: string }) => c.groupId === out.groupId));
    assert.equal(out.comments[0].kind, "idea");
    await until(() => typed.length > 0);
    const again = await (await fetch(`${base}/api/page-comments/teams/${team.id}/groups`, json(body))).json();
    assert.deepEqual(again.comments.map((c: { id: string }) => c.id), out.comments.map((c: { id: string }) => c.id), "the same ids again");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(typed.length, 1, "one message, once");
    assert.match(typed[0]!, /\[Page comments: 2 in group/);
    assert.match(typed[0]!, /Open to check: http:\/\/localhost:3000\/b/);
    assert.equal((await fetch(`${base}/api/page-comments/teams/${team.id}/groups`, json({ comments: [] }))).status, 400);
  }, live);
});

test("after delivery an edit reaches the lead as a follow-up on the same id, and a withdrawal tells the lead and closes it", async () => {
  await office(async ({ base, world, typed, comments }) => {
    const { team } = await seat(world);
    const sent = comments.enqueue(team.id, { text: "The title is wrong.", kind: "copy", page: { url: "http://localhost:3000/a" } });
    assert.equal(sent.editable, false, "the lead has it");
    assert.match(sent.messageId ?? "", /./);
    await until(() => typed.length === 1);
    assert.match(typed[0]!, /\[Page comment · copy\]/, "the lead sees the kind");
    const stream = sse(`${base}/api/page-comments/events?ids=${sent.id}`);
    try {
      const edited = await (await fetch(`${base}/api/page-comments/${sent.id}/edit`, json({ text: "The subtitle is wrong, not the title." }))).json();
      assert.equal(edited.revision, 1);
      assert.equal(edited.text, "The subtitle is wrong, not the title.");
      assert.equal(edited.messageId, sent.messageId, "the comment still points at its first message");
      await until(() => typed.length === 2);
      assert.match(typed[1]!, new RegExp(`\\[Page comment ${sent.id} edited\\][^]*this replaces what you have:\\n\\n\\[Page comment · copy\\]\\nOn http://localhost:3000/a\\n\\nThe subtitle is wrong, not the title\\.`));
      // The same edit again sends nothing.
      await fetch(`${base}/api/page-comments/${sent.id}/edit`, json({ text: "The subtitle is wrong, not the title." }));
      await until(() => stream.events.some((e) => e.revision === 1));
      const withdrawn = await (await fetch(`${base}/api/page-comments/${sent.id}/withdraw`, json({ note: "Already fixed upstream" }))).json();
      assert.equal(withdrawn.status, "withdrawn");
      await until(() => typed.length === 3);
      assert.match(typed[2]!, new RegExp(`\\[Page comment ${sent.id} withdrawn\\]\\nThe page withdrew this comment: Already fixed upstream\\. Stop any work on it`));
      await until(() => stream.events.some((e) => e.status === "withdrawn"));
      assert.equal((await fetch(`${base}/api/page-comments/${sent.id}/status`, json({ status: "fixed" }))).status, 409, "a withdrawn comment stays closed");
      assert.equal((await fetch(`${base}/api/page-comments/${sent.id}/edit`, json({ text: "x" }))).status, 409);
      assert.equal((await fetch(`${base}/api/page-comments/${sent.id}/withdraw`, json({}))).status, 200, "withdrawing twice is fine");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(typed.length, 3);
      assert.equal((await fetch(`${base}/api/page-comments/${sent.id}/edit`, json({}))).status, 400, "an edit says what changes");
    } finally { await stream.close(); }
  }, live);
});

test("`inbox comment ask` puts a question to the page; the answer reaches the lead on that comment and work goes on", async () => {
  await office(async ({ base, world, typed, comments }) => {
    const { team, lead } = await seat(world);
    const held = comments.enqueue(team.id, { text: "held", hold: true });
    assert.equal((await fetch(`${base}/api/page-comments/${held.id}/ask`, json({ question: "?" }))).status, 409, "nothing to ask about before the team has it");
    const sent = comments.enqueue(team.id, { text: "The units look off.", page: { url: "http://localhost:3000/u" } });
    await until(() => typed.length === 1);
    const stream = sse(`${base}/api/page-comments/events?origin=http://localhost:3000`);
    try {
      const run = (...args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env, INBOX_URL: base };
        for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "HERDR_PANE_ID"]) delete env[k];
        execFile(process.execPath, ["bin/inbox", ...args], { env }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
      });
      assert.notEqual((await run("comment", "ask", sent.id)).code, 0, "a question is needed");
      const asked = await run("comment", "ask", sent.id, "Which units: m/s or km/h?", "--harness", "pi", "--session", "s1");
      assert.equal(asked.code, 0, asked.out);
      assert.match(asked.out, /asked: Which units: m\/s or km\/h\?/);
      assert.equal(comments.get(sent.id).status, "asked");
      assert.equal(comments.get(sent.id).by, lead.name);
      await until(() => stream.events.some((e) => e.status === "asked"));
      const event = stream.events.find((e) => e.status === "asked")!;
      assert.equal(event.question, "Which units: m/s or km/h?", "the page hears the question in the event");
      assert.equal((await fetch(`${base}/api/page-comments/${sent.id}/answer`, json({}))).status, 400);
      const answered = await (await fetch(`${base}/api/page-comments/${sent.id}/answer`, json({ text: "km/h, like the speedometer." }))).json();
      assert.equal(answered.status, "working");
      assert.equal(answered.answer, "km/h, like the speedometer.");
      await until(() => typed.length === 2);
      assert.match(typed[1]!, new RegExp(`^p1: [^]*\\[Page comment ${sent.id} answered\\]\\nYou asked: Which units: m/s or km/h\\?\\nThe answer: km/h, like the speedometer\\.`));
      // A repeated answer is the same answer; another one without a question is refused.
      assert.equal((await fetch(`${base}/api/page-comments/${sent.id}/answer`, json({ text: "km/h, like the speedometer." }))).status, 200);
      assert.equal((await fetch(`${base}/api/page-comments/${sent.id}/answer`, json({ text: "m/s" }))).status, 409);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(typed.length, 2);
      const shown = await run("comment", "show", sent.id);
      assert.match(shown.out, /answer: km\/h/);
    } finally { await stream.close(); }
  }, live);
});

test("the widget acts on a host's comments only with well-formed requests about that host's own page", () => {
  const allow = ["http://localhost:*"];
  const from = (data: Record<string, unknown>) => acceptEmbedMessage("http://localhost:3000", { version: 1, ...data }, allow);
  assert.deepEqual(from({ type: "office-comment:edit", requestId: "r1", id: "pc-0123456789", text: "new", kind: "  bug  ", openUrl: "https://bank.example/", meta: { a: 1 } }),
    { type: "edit", requestId: "r1", id: "pc-0123456789", edit: { text: "new", kind: "bug", meta: { a: 1 } } }, "an openUrl elsewhere is dropped");
  assert.equal(from({ type: "office-comment:edit", id: "../teams" }), null);
  assert.deepEqual(from({ type: "office-comment:withdraw", id: "pc-0123456789" }), { type: "withdraw", requestId: null, id: "pc-0123456789" });
  assert.equal(from({ type: "office-comment:answer", id: "pc-0123456789", text: "  " }), null);
  assert.deepEqual(from({ type: "office-comment:answer", id: "pc-0123456789", text: "yes" }), { type: "answer", requestId: null, id: "pc-0123456789", text: "yes" });
  assert.deepEqual(from({ type: "office-comment:send-group", comments: [{ text: "a", kind: "idea", page: { url: "https://bank.example/" } }, { text: "b", openUrl: "http://localhost:3000/b" }] }),
    { type: "send-group", requestId: null, comments: [{ text: "a", kind: "idea", page: {} }, { text: "b", page: {}, openUrl: "http://localhost:3000/b" }] });
  assert.equal(from({ type: "office-comment:send-group", comments: [] }), null);
  assert.equal(from({ type: "office-comment:send-group", comments: [{ text: "" }] }), null);
  assert.equal(acceptEmbedMessage("https://evil.example", { version: 1, type: "office-comment:withdraw", id: "pc-0123456789" }, allow), null);
  assert.equal(pageCommentText("hi", {}, "unsure"), "[Page comment · unsure]\n\nhi");
});

test("the founder verifies a fix or finds it still wrong, which reopens the same comment with the attempt kept; lists select verified or not", async () => {
  await office(async ({ base, world, typed, comments }) => {
    const { team } = await seat(world);
    const fix = async (text: string) => {
      const c = comments.enqueue(team.id, { text, kind: "bug", page: { url: "http://localhost:3000/v", title: "V" }, openUrl: "http://localhost:3000/v?step=1", meta: { step: 1 } });
      return comments.setStatus(c.id, { status: "fixed", note: `fixed ${text}`, commit: "abc1234", url: "http://localhost:3000/v?step=1#done" });
    };
    const good = await fix("good");
    const bad = await fix("bad");
    const open = comments.enqueue(team.id, { text: "not fixed yet" });
    const verify = (id: string, body: unknown) => fetch(`${base}/api/page-comments/${id}/verify`, json(body));
    assert.equal((await verify(open.id, { verdict: "verified" })).status, 409, "only a fixed comment is checked");
    assert.equal((await verify(good.id, { verdict: "maybe" })).status, 400);
    const list = async (q: string) => ((await (await fetch(`${base}/api/page-comments?team=${team.id}&${q}`)).json()).comments as Array<{ id: string }>).map((c) => c.id).sort();
    assert.deepEqual(await list("verified=false"), [good.id, bad.id].sort(), "fixed and not yet verified");

    const stream = sse(`${base}/api/page-comments/events?team=${team.id}&verified=true&limit=1`);
    try {
      const ok = await (await verify(good.id, { verdict: "verified" })).json();
      assert.equal(ok.comment.verification, "verified");
      assert.match(ok.comment.verifiedAt, /^\d{4}-/);
      assert.equal(ok.followUp, null);
      assert.equal((await (await verify(good.id, { verdict: "verified" })).json()).comment.verifiedAt, ok.comment.verifiedAt, "verifying twice changes nothing");
      await until(() => stream.events.some((e) => e.id === good.id && e.verification === "verified"));
      assert.ok(stream.events.every((e) => e.verification === "verified"), "the verified stream hears only verified fixes");
    } finally { await stream.close(); }
    assert.deepEqual(await list("verified=true"), [good.id]);

    const before = typed.length;
    const wrong = await (await verify(bad.id, { verdict: "still-wrong", note: "The label still overlaps on phones." })).json();
    assert.equal(wrong.followUp, null, "no follow-up comment: the same one reopens");
    assert.equal(wrong.comment.id, bad.id);
    assert.equal(wrong.comment.status, "working");
    assert.equal(wrong.comment.verification, null);
    assert.equal(wrong.comment.commit, null);
    assert.equal(wrong.comment.openUrl, "http://localhost:3000/v?step=1", "back to the page's own open URL, not the earlier fix's");
    assert.deepEqual(wrong.comment.history.map((a: { commit: string; note: string; url: string; verdictNote: string }) => [a.commit, a.note, a.url, a.verdictNote]),
      [["abc1234", "fixed bad", "http://localhost:3000/v?step=1#done", "The label still overlaps on phones."]]);
    await until(() => typed.length > before);
    assert.match(typed.at(-1)!, new RegExp(`\\[Page comment ${bad.id} still wrong\\][\\s\\S]*commit abc1234, “fixed bad”[\\s\\S]*The label still overlaps on phones\\.`));
    // The same verdict again changes nothing; another verdict waits for the next fix.
    assert.equal((await (await verify(bad.id, { verdict: "still-wrong", note: "The label still overlaps on phones." })).json()).comment.history.length, 1);
    assert.equal((await verify(bad.id, { verdict: "verified" })).status, 409, "judge the next fix");
    assert.deepEqual(await list("verified=false"), [], "a reopened comment is not fixed");
  }, live);
});

test("a page can name the comment it follows up when it queues one; an unknown one is refused", async () => {
  await office(async ({ base, world, typed, comments }) => {
    const { team } = await seat(world);
    const earlier = comments.enqueue(team.id, { text: "Wrong colour" });
    comments.setStatus(earlier.id, { status: "declined", note: "On purpose: it matches the brand" });
    const stream = sse(`${base}/api/page-comments/events?ids=${earlier.id}&limit=1`);
    try {
      const later = await (await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "It really clashes with the chart.", followsUp: earlier.id }))).json();
      assert.equal(later.followsUp, earlier.id);
      await until(() => stream.events.some((e) => (e.followUps as string[]).includes(later.id)));
      assert.deepEqual(comments.get(earlier.id).followUps, [later.id], "the earlier comment's page hears of it");
      await until(() => typed.some((t) => t.includes("It really clashes")));
      assert.match(typed.find((t) => t.includes("It really clashes"))!, new RegExp(`Follows up page comment ${earlier.id} \\(declined; note: On purpose: it matches the brand\\): “Wrong colour”`));
    } finally { await stream.close(); }
    assert.equal((await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "x", followsUp: "pc-0000000000" }))).status, 404);
    assert.equal((await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "x", followsUp: "nope" }))).status, 400);
  }, live);
});

test("a page's backend uploads a screenshot without an Origin header and attaches it to a comment", async () => {
  await office(async ({ base, world, typed }) => {
    const { team } = await seat(world);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const up = await fetch(`${base}/api/uploads`, json({ data: png }));
    assert.equal(up.status, 200, "no Origin: a local process, as before");
    const { id } = await up.json();
    assert.equal((await fetch(`${base}/api/uploads`, json({ data: png }, { origin: "http://localhost:3000" }))).status, 403, "a page's browser cannot upload directly");
    const sent = await (await fetch(`${base}/api/page-comments/teams/${team.id}/comments`, json({ text: "See the screenshot", images: [id] }))).json();
    assert.deepEqual(sent.images, [id]);
    await until(() => typed.some((t) => t.includes("See the screenshot")));
    assert.equal(world.messages.message(sent.messageId).images.length, 1, "the lead gets the image with the comment");
    assert.equal((await fetch(`${base}/uploads/${id}`)).status, 200);
  }, live);
});

test("the widget relays a verdict only when it is one of the two", () => {
  const allow = ["http://localhost:*"];
  const from = (data: Record<string, unknown>) => acceptEmbedMessage("http://localhost:3000", { version: 1, type: "office-comment:verify", id: "pc-0123456789", ...data }, allow);
  assert.deepEqual(from({ verdict: "still-wrong", note: "overlaps" }), { type: "verify", requestId: null, id: "pc-0123456789", verdict: "still-wrong", note: "overlaps" });
  assert.equal(from({ verdict: "fine" }), null);
});

test("the page-comment table exists from migration 18 on", () => {
  const db = openDatabase(":memory:");
  assert.ok(Number(db.prepare("PRAGMA user_version").get()!.user_version) >= 18, "later migrations may follow it");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'page_comments'").get());
});

test("a database made at migration 18 before kinds, groups and checks gets their columns, keeping its comments", () => {
  const db = openDatabase(":memory:");
  // As migration 18 first shipped: drop what came later.
  for (const c of ["kind", "group_id", "question", "answer", "revision", "follows_up", "verification", "verified_at"]) {
    db.exec(`DROP INDEX IF EXISTS page_comments_group; DROP INDEX IF EXISTS page_comments_follows; ALTER TABLE page_comments DROP COLUMN ${c}`);
  }
  db.prepare(`INSERT INTO page_comments (id, team_id, text, page, status, attempts, fingerprint, created_at, updated_at)
    VALUES ('pc-0123456789', 't', 'old', '{}', 'fixed', 1, 'f', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run();
  const comments = new PageComments(db, { state: () => ({ teams: [], agents: [] }) as never, instruct: () => { throw new Error("no"); }, message: () => { throw new Error("no"); } }, join(tmpdir(), "unused.json"));
  const old = comments.get("pc-0123456789");
  assert.deepEqual([old.text, old.kind, old.groupId, old.revision, old.verification, old.followUps], ["old", null, null, 0, null, []]);
  new PageComments(db, { state: () => ({ teams: [], agents: [] }) as never, instruct: () => { throw new Error("no"); }, message: () => { throw new Error("no"); } }, join(tmpdir(), "unused.json"));
});
