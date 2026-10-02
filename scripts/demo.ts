// A self-contained fictional demo: temporary HOME/database, free loopback ports, no account,
// presence or process-cleanup integrations. `npm run demo`; Ctrl-C removes the scratch data.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { formatReply } from "../src/shared/agent-client.ts";
import type { PendingReply, SessionInput, SubmitInput, SubmitResult } from "../src/shared/types.ts";

const assets = join(import.meta.dirname, "demo-assets");
const shot = (file: string, caption: string) => ({ path: join(assets, file), caption, sourceRevision: "fictional-demo-v1" });
const notes: SessionInput = { harness: "pi", sessionId: "demo-pi-notes" };
const ledger: SessionInput = { harness: "codex", sessionId: "demo-codex-ledger" };
const planner: SessionInput = { harness: "claude", sessionId: "demo-claude-planner" };

export function demoSubmissions(previewUrl: string): SubmitInput[] {
  return [
    {
      session: notes,
      project: { name: "Lantern", root: "/demo/lantern", objective: "A fictional personal notes app" },
      task: { title: "Note search", objective: "Find a note without covering the current draft" },
      item: {
        key: "search-placement", type: "decide", title: "Where should the search panel sit?",
        request: "Pick where search opens. Until you answer, I will keep it docked.",
        context: "The search results can overlay the draft or occupy a separate column. These purpose-made illustrations show the notebook with search closed and docked.",
        recommendation: "Docked: keeps the draft visible while choosing a result.",
        options: [
          { id: "a", label: "Overlay", consequence: "The editor stays wide, but search covers part of the draft." },
          { id: "b", label: "Docked column", consequence: "The editor narrows while search is open; nothing is covered." },
        ],
        evidence: [shot("search-closed.png", "Lantern notebook, search closed"), shot("search-docked.png", "Search in a separate column")],
      },
    },
    {
      session: ledger,
      project: { name: "Pocket ledger", root: "/demo/pocket-ledger", objective: "Fictional monthly bookkeeping" },
      task: { title: "Import summary", objective: "Show clear categories and flag uncertain entries" },
      item: {
        key: "import-preview", type: "try", title: "Check the sample import summary",
        request: "Read the three sample rows and check the categories are clear.",
        context: "This is a static, made-up preview, not a receipt uploader. No files are read or dropped.",
        check: "Check that Market basket is Food, Station ticket is Travel, and Blurry sample is Check me.",
        preview: { url: previewUrl, viewport: "desktop", setup: "Static preview with three bundled sample rows. No drag-and-drop or sample folder needed." },
        blocking: false,
      },
    },
    {
      session: planner,
      project: { name: "Pebble", root: "/demo/pebble", objective: "A fictional gentle daily planner" },
      task: { title: "Planner layouts", objective: "Review the week, day and category layouts" },
      item: {
        key: "planner-layouts", type: "milestone", title: "Week, day and category layouts are ready for review",
        request: "Accept the layouts, or say what should change before implementation.",
        context: "These are purpose-made mock interfaces with invented sample plans, not screenshots of a shipped app.",
        evidence: [shot("planner-week.png", "Week overview"), shot("planner-day.png", "Day plan"), shot("planner-tags.png", "Plans by category")],
      },
    },
  ];
}

export const LEDGER_PREVIEW = `<!doctype html><meta charset="utf-8"><title>Pocket ledger sample</title>
<body style="font:18px system-ui;margin:40px;color:#283b34;background:#fffdf7"><h1>Pocket ledger</h1>
<p>Static fictional import summary. No uploading or drag-and-drop.</p>
<table style="margin-top:24px;border-spacing:20px;text-align:left"><tr><th>Sample</th><th>Category</th></tr>
<tr><td>Market basket</td><td>Food</td></tr><tr><td>Station ticket</td><td>Travel</td></tr><tr><td>Blurry sample</td><td><b>Check me</b></td></tr></table></body>`;

const listen = (server: Server, port: number) => new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
});
const portOf = (server: Server) => (server.address() as { port: number }).port;
const closeServer = (server: Server) => new Promise<void>((resolve) => {
  server.closeAllConnections(); server.close(() => resolve());
});
async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(kill);
}

export async function startDemo({ officePort = 0, previewPort = 0, log = console.log }: {
  officePort?: number; previewPort?: number; log?: (text: string) => void;
} = {}) {
  if (officePort === 4870 || previewPort === 4870) throw new Error("Demo must never use the live office's port 4870");
  const home = await mkdtemp(join(tmpdir(), "review-inbox-demo-"));
  const preview = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(LEDGER_PREVIEW);
  });
  let office: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let polling: Promise<void> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    await polling;
    if (office) await stopChild(office);
    await closeServer(preview);
    await rm(home, { recursive: true, force: true });
  };
  try {
    await listen(preview, previewPort);
    const previewUrl = `http://localhost:${portOf(preview)}/`;
    // Reserve a free port for the child service; ordinary startup need not know about demo mode.
    const reservation = createServer();
    await listen(reservation, officePort);
    const port = portOf(reservation);
    await closeServer(reservation);
    const url = `http://localhost:${port}`;
    const dir = join(home, "data");
    office = spawn(process.execPath, [fileURLToPath(new URL("../src/server/main.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, HOME: home, INBOX_DATA_DIR: dir, INBOX_PORT: String(port), HERDR_SOCKET_PATH: "/nonexistent", HERDR_BIN_PATH: "/usr/bin/false", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let spawnError: Error | undefined;
    office.on("error", (e) => { spawnError = e; });
    office.stdout?.on("data", (d) => { output += d; });
    office.stderr?.on("data", (d) => { output += d; });
    for (let i = 0; ; i++) {
      if (spawnError) throw spawnError;
      if (office.exitCode !== null || office.signalCode !== null) throw new Error(`Demo office stopped: ${output}`);
      try { if ((await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      if (i === 100) throw new Error(`Demo office did not start: ${output}`);
      await delay(100);
    }
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? `Demo service returned ${res.status}`);
      return out as T;
    };
    for (const submission of demoSubmissions(previewUrl)) {
      const result = await post<SubmitResult>("/api/agent/items", submission);
      log(`submitted ${submission.item.type}: ${submission.item.title} (revision ${result.revision})`);
    }
    await post("/api/agent/activity", { session: notes, activity: "Comparing docked search with an overlay", nextMilestone: "Implement the chosen layout" });
    const received = new Set<string>();
    timer = setInterval(() => {
      if (closed || polling) return;
      polling = (async () => {
        try {
          for (const reply of await post<PendingReply[]>("/api/agent/replies", { session: notes, mode: "live" })) {
            if (!received.has(reply.deliveryId)) { log(`${formatReply(reply)}\n`); received.add(reply.deliveryId); }
            await post("/api/agent/ack", { session: notes, deliveryId: reply.deliveryId });
          }
        } catch (e) { if (!closed) log(`Demo listener: ${(e as Error).message}`); }
      })().finally(() => { polling = undefined; });
    }, 2000);
    log(`\nReview Inbox demo: ${url}\nStatic sample preview: ${previewUrl}\nTemporary data: ${dir}\nAnswer Lantern's decision to see the pretend agent receive it. Ctrl-C stops both servers and removes demo data.`);
    return { url, previewUrl, home, dir, close };
  } catch (err) { await close(); throw err; }
}

if (import.meta.main) {
  const demo = await startDemo({ officePort: Number(process.env.DEMO_PORT ?? 0), previewPort: Number(process.env.DEMO_PREVIEW_PORT ?? 0) });
  const stop = () => { void demo.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
