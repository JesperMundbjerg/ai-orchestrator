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
  const port = nextPort++;
  const server = createInboxServer(inbox, null, { port, staticDir: ui, world, pageComments });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
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
      assert.deepEqual(last, { id: sent.id, teamId: team.id, status: "fixed", openUrl: "http://localhost:3000/lessons/orbits?step=2#focus", note: "Reworded", commit: "abc1234", meta: { lesson: "orbits", step: 2 }, updatedAt: last.updatedAt });
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
