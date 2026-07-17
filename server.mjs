// AI Orchestrator — supervises ONE persistent headless Claude Code process and
// bridges it to a browser voice console over a tiny HTTP + Server-Sent-Events API.
//
// Zero dependencies by design (node: builtins only). Target: Windows 11, Node 18+.
// The subprocess protocol below was verified empirically against claude CLI 2.1.212
// and is treated as ground truth.

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 4870;
const HOST = "127.0.0.1";
// Model alias for the session. Default is intentionally "opus" — never another model.
const MODEL = process.env.ORCHESTRATOR_MODEL || "opus";

// server.mjs lives at the repo root, so its own directory IS the repo root. The
// subprocess MUST run here so the repo's CLAUDE.md persona and the permission
// allowlist in .claude/settings.json load into the session.
const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(REPO_ROOT, "public", "index.html");

// Broadcast to SSE clients when we detect the workspace-trust warning on stderr.
const TRUST_REMEDY =
  'Workspace not trusted: permissions in .claude/settings.json are ignored. ' +
  'Fix: run claude interactively once in this repo and accept the trust dialog, ' +
  'or set projects["C:/projects/ai-orchestrator"].hasTrustDialogAccepted = true in ' +
  '~/.claude.json, then restart.';

const RING_MAX = 200; // events replayed to a freshly-connected SSE client
const PING_MS = 25000; // SSE keep-alive comment interval
const MAX_BODY = 1_000_000; // /say request body cap (bytes)
const MAX_SPAWN_FAILURES = 5;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30000;

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

let state = null; // "starting" | "ready" | "thinking" | "dead"
let sessionId = null; // captured from system/init (stays constant across turns)
let model = MODEL; // overwritten with the resolved model-id from system/init

let child = null; // the claude subprocess, or null while down
let inTurn = false; // true from user-message forward until that turn's result
let turnStart = null; // Date.now() when the current turn's message was forwarded

let spawnFailures = 0; // consecutive failed spawns (reset on a healthy init)
let respawnDelay = BACKOFF_START_MS;
let respawnTimer = null;
let shuttingDown = false;

let stdoutBuffer = ""; // partial JSONL line carried across stdout chunks
let stderrBuffer = ""; // rolling stderr tail (for cross-chunk trust detection)
let trustWarned = false; // one trust warning per spawn is enough

// ---------------------------------------------------------------------------
// SSE broadcasting + ring buffer
// ---------------------------------------------------------------------------

const clients = new Set();
const ring = [];

function broadcast(event) {
  const payload = { ...event, ts: Date.now() };
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  ring.push(payload);
  if (ring.length > RING_MAX) ring.shift();
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      // A dead socket is cleaned up by its own close handler; ignore here.
    }
  }
}

function setState(next) {
  if (state === next) return;
  state = next;
  broadcast({ kind: "state", state, sessionId, model });
}

// ---------------------------------------------------------------------------
// Subprocess handling
// ---------------------------------------------------------------------------

function spawnChild() {
  if (shuttingDown) return;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  if (child) return; // already alive

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", MODEL,
  ];
  // Resume the same conversation after an unexpected exit so context survives.
  if (sessionId) args.push("--resume", sessionId);

  setState("starting");
  stdoutBuffer = "";
  stderrBuffer = "";
  trustWarned = false;

  let proc;
  try {
    // Windows Node >=18.20 needs a shell to run the claude.cmd shim. The args are
    // static string literals (user text travels over stdin, never argv), so shell
    // concatenation is safe. The DEP0190 deprecation warning is expected/acceptable.
    proc = spawn("claude", args, { shell: true, windowsHide: true, cwd: REPO_ROOT });
  } catch (err) {
    broadcast({ kind: "error", message: `Failed to spawn claude: ${err.message}` });
    scheduleRespawn();
    return;
  }

  child = proc;

  // 'error' and 'exit' can both fire (or only one) for a single spawn; collapse
  // them into a single respawn decision with a settled guard.
  let settled = false;
  const onDone = (reason) => {
    if (settled) return;
    settled = true;
    if (proc === child) child = null;
    inTurn = false;
    turnStart = null;
    if (shuttingDown) return;
    broadcast({ kind: "error", message: reason });
    scheduleRespawn();
  };

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", onStderr);
  // Guard against EPIPE crashing the server if the process dies mid-write.
  proc.stdin.on("error", (err) =>
    console.error("[orchestrator] stdin error:", err.message)
  );
  proc.on("error", (err) => onDone(`claude process error: ${err.message}`));
  proc.on("exit", (code, signal) =>
    onDone(`claude exited (code=${code}, signal=${signal}).`)
  );
}

function scheduleRespawn() {
  if (shuttingDown) return;
  spawnFailures += 1;
  if (spawnFailures >= MAX_SPAWN_FAILURES) {
    setState("dead");
    broadcast({
      kind: "error",
      message: `Orchestrator gave up after ${MAX_SPAWN_FAILURES} consecutive spawn failures. Send a message to retry.`,
    });
    return;
  }
  const delay = respawnDelay;
  respawnDelay = Math.min(respawnDelay * 2, BACKOFF_CAP_MS); // double, capped
  broadcast({
    kind: "error",
    message: `Respawning claude in ${Math.round(delay / 1000)}s (attempt ${spawnFailures} of ${MAX_SPAWN_FAILURES}).`,
  });
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    spawnChild();
  }, delay);
}

// Ensure a live process exists for an incoming message; resets the give-up
// counter if we had previously gone "dead" so a new message can retry.
function ensureChild() {
  if (child) return;
  if (state === "dead") {
    spawnFailures = 0;
    respawnDelay = BACKOFF_START_MS;
  }
  spawnChild();
}

// ---------------------------------------------------------------------------
// stdout: JSONL stream → SSE events
// ---------------------------------------------------------------------------

function onStdout(chunk) {
  stdoutBuffer += chunk;
  let nl;
  while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, nl).trim();
    stdoutBuffer = stdoutBuffer.slice(nl + 1);
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      // Never crash on a malformed line — log a bounded preview and skip.
      console.warn("[orchestrator] skipping unparseable stdout line:", line.slice(0, 200));
      continue;
    }
    try {
      handleEvent(evt);
    } catch (err) {
      console.error("[orchestrator] error handling event:", err);
    }
  }
}

function handleEvent(evt) {
  if (!evt || typeof evt !== "object") return;
  switch (evt.type) {
    case "system":
      // A fresh init is emitted at the START of every turn (session_id constant).
      if (evt.subtype === "init") {
        if (typeof evt.session_id === "string") sessionId = evt.session_id;
        if (typeof evt.model === "string") model = evt.model;
        // Reaching init proves a healthy spawn — reset the failure backoff.
        spawnFailures = 0;
        respawnDelay = BACKOFF_START_MS;
        // Only leave "starting" here; a mid-turn init must NOT clobber "thinking".
        if (!inTurn) setState("ready");
      }
      // hook_started / hook_response / thinking_tokens etc.: ignore.
      break;
    case "assistant":
      handleAssistant(evt);
      break;
    case "result":
      handleResult(evt);
      break;
    // rate_limit_event and any unknown types: ignore.
    default:
      break;
  }
}

function handleAssistant(evt) {
  const content =
    evt.message && Array.isArray(evt.message.content) ? evt.message.content : [];
  const textParts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      broadcast({ kind: "tool", name, detail: summarizeToolInput(name, block.input) });
    }
  }
  // One assistant event per message, concatenating that message's text blocks.
  if (textParts.length > 0) {
    const text = textParts.join("");
    if (text.trim()) broadcast({ kind: "assistant", text });
  }
}

function handleResult(evt) {
  // Any result event is end-of-turn, regardless of subtype (success or error).
  const ms = turnStart != null ? Date.now() - turnStart : null;
  const costUsd = typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : null;
  broadcast({ kind: "result", ms, costUsd });
  if (typeof evt.session_id === "string") sessionId = evt.session_id;
  inTurn = false;
  turnStart = null;
  setState("ready");
}

function summarizeToolInput(name, input) {
  let detail;
  if (name === "Bash" && input && typeof input.command === "string") {
    detail = input.command;
  } else {
    try {
      detail = JSON.stringify(input);
    } catch {
      detail = String(input);
    }
  }
  if (typeof detail !== "string") detail = String(detail);
  return detail.length > 160 ? detail.slice(0, 159) + "…" : detail;
}

// ---------------------------------------------------------------------------
// stderr: log + detect the workspace-trust warning
// ---------------------------------------------------------------------------

function onStderr(chunk) {
  process.stderr.write(`[claude stderr] ${chunk}`);
  stderrBuffer += chunk;
  if (stderrBuffer.length > 65536) stderrBuffer = stderrBuffer.slice(-65536);
  // "has not been trusted" means .claude/settings.json permissions are IGNORED.
  if (!trustWarned && stderrBuffer.includes("has not been trusted")) {
    trustWarned = true;
    broadcast({ kind: "error", message: TRUST_REMEDY });
  }
}

// ---------------------------------------------------------------------------
// Forwarding a user message to the subprocess
// ---------------------------------------------------------------------------

function forwardMessage(text) {
  const msg = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  try {
    child.stdin.write(JSON.stringify(msg) + "\n");
    return true;
  } catch (err) {
    broadcast({ kind: "error", message: `Failed to write to orchestrator stdin: ${err.message}` });
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function serveIndex(res) {
  fs.readFile(INDEX_HTML, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("public/index.html not found. Another component provides the browser console page.");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

function serveEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  // Replay recent history so a reconnecting client catches up.
  for (const payload of ring) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  clients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* cleaned up on close */
    }
  }, PING_MS);

  const cleanup = () => {
    clearInterval(ping);
    clients.delete(res);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function serveStatus(res) {
  sendJson(res, 200, { state, sessionId, model, port: PORT });
}

function handleSay(req, res) {
  let body = "";
  let aborted = false;
  req.on("data", (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_BODY) {
      aborted = true;
      sendJson(res, 413, { ok: false, error: "Request body too large." });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (aborted) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
    }
    const text = parsed && parsed.text;
    if (typeof text !== "string" || text.trim() === "") {
      return sendJson(res, 400, { ok: false, error: "Field 'text' must be a non-empty string." });
    }

    // A message arriving while no process is alive: try to (re)spawn, else 503.
    if (!child) ensureChild();
    if (!child || !child.stdin || !child.stdin.writable) {
      return sendJson(res, 503, {
        ok: false,
        error: "Orchestrator process is not available. Try again shortly.",
      });
    }

    if (!forwardMessage(text)) {
      return sendJson(res, 503, {
        ok: false,
        error: "Failed to forward message to the orchestrator process.",
      });
    }

    turnStart = Date.now(); // measure turn wall-time from the forward
    inTurn = true;
    broadcast({ kind: "user", text });
    setState("thinking");
    sendJson(res, 202, { ok: true });
  });
  req.on("error", () => {
    if (!aborted) sendJson(res, 400, { ok: false, error: "Request error." });
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || HOST}`).pathname;
  } catch {
    return sendJson(res, 400, { ok: false, error: "Bad request URL." });
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveIndex(res);
  }
  if (req.method === "GET" && pathname === "/events") {
    return serveEvents(req, res);
  }
  if (req.method === "GET" && pathname === "/status") {
    return serveStatus(res);
  }
  if (req.method === "POST" && pathname === "/say") {
    return handleSay(req, res);
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  console.log(`AI Orchestrator listening on http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  spawnChild();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (respawnTimer) clearTimeout(respawnTimer);
  if (child) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
