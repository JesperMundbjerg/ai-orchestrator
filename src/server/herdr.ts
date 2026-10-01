// Presence from herdr: which harness runs in which pane, under which session, and whether it
// is working. herdr is optional — without it tasks simply have no presence and cannot be
// brought to the front. It is never used to deliver replies.
//
// The agent list is re-read whenever herdr's socket reports a status change or a pane coming
// or going, so a lamp changes within a moment. Polling stays as the fallback when the socket
// is unreachable and as a slow safety net when it is not.

import { execFile } from "node:child_process";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HARNESSES, type Harness, type Presence } from "../shared/types.ts";
import type { PresenceSource } from "./inbox.ts";
import type { AgentSource, LiveAgent } from "./world.ts";
import { StaleWorking } from "./stale.ts";
import { nextSplit, type PaneRect } from "../shared/panes.ts";

const run = promisify(execFile);
const POLL_MS = 3000;
const SUBSCRIBED_POLL_MS = 20_000;

interface HerdrAgent {
  agent?: string;
  agent_session?: { value?: string };
  agent_status?: Presence["status"];
  cwd?: string;
  name?: string;
  pane_id: string;
  terminal_title_stripped?: string;
}

export class Herdr implements PresenceSource, AgentSource {
  private agents: HerdrAgent[] = [];
  private ok = false;
  private timer: NodeJS.Timeout | null = null;
  private bin: string;
  private socketPath: string;
  private events: { socket: Socket; panes: string; live: boolean } | null = null;
  private pending: NodeJS.Timeout | null = null;
  onChange: () => void = () => {};
  queuedPanes: () => ReadonlySet<string> = () => new Set();
  private stale = new StaleWorking();
  private refreshing: Promise<void> | null = null;
  private now: () => number;

  /** The socket is the session the CLI talks to: `HERDR_SOCKET_PATH` inside herdr, else the default session. */
  constructor(bin = process.env.HERDR_BIN_PATH ?? "herdr", socketPath = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock"), now = Date.now) {
    this.now = now;
    this.bin = bin;
    this.socketPath = socketPath;
  }

  start(): void {
    const tick = async () => {
      await this.refresh();
      this.subscribe();
      this.timer = setTimeout(tick, this.events?.live ? SUBSCRIBED_POLL_MS : POLL_MS);
      this.timer.unref();
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.events?.socket.destroy();
    this.events = null;
  }

  /**
   * Keeps one subscription open for the panes herdr has now. Status events are per pane, so a
   * new pane means a new subscription; every event just triggers a re-read of the list.
   */
  private subscribe(): void {
    const panes = this.agents.map((a) => a.pane_id).sort().join(",");
    if (!this.ok || this.events?.panes === panes) return;
    this.events?.socket.destroy();
    const socket = connect(this.socketPath);
    const events = { socket, panes, live: false };
    this.events = events;
    let buffer = "";
    socket.unref();
    socket.on("connect", () => {
      const subscriptions = [
        ...["pane.created", "pane.closed", "pane.exited", "pane.agent_detected"].map((type) => ({ type })),
        ...this.agents.map((a) => ({ type: "pane.agent_status_changed", pane_id: a.pane_id })),
      ];
      socket.write(`${JSON.stringify({ id: "review-inbox", method: "events.subscribe", params: { subscriptions } })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { result?: { type?: string }; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          message = { error: "unreadable event" };
        }
        if (message.error) socket.destroy();
        else if (message.result?.type === "subscription_started") events.live = true;
        else this.soon();
      }
    });
    // A closed or refused socket falls back to polling; the next tick subscribes again.
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.events === events) this.events = null;
    });
  }

  /** Coalesces a burst of events into one re-read. */
  private soon(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.refresh().then(() => this.subscribe());
    }, 150);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  private async refreshOnce(): Promise<void> {
    const before = JSON.stringify([this.ok, this.agents.map((a) => fingerprint(this.effective(a)))]);
    let next: HerdrAgent[] = [];
    let ok = false;
    try {
      const { stdout } = await run(this.bin, ["agent", "list"], { timeout: 2500 });
      next = (JSON.parse(stdout) as { result?: { agents?: HerdrAgent[] } }).result?.agents ?? [];
      ok = true;
    } catch {
      // herdr not installed or not running: no presence, which is a valid state.
    }
    await this.stale.sample(next, this.queuedPanes(), async (paneId) => {
      const { stdout } = await run(this.bin, ["pane", "read", paneId, "--source", "visible", "--lines", "80", "--format", "text", "--raw"], { timeout: 2500, maxBuffer: 256_000 });
      return stdout;
    }, this.now);
    this.agents = next;
    this.ok = ok;
    if (JSON.stringify([ok, next.map((a) => fingerprint(this.effective(a)))]) !== before) this.onChange();
  }

  private effective(a: HerdrAgent): HerdrAgent {
    return a.agent_status === "working" && this.stale.isStale(a.pane_id) ? { ...a, agent_status: "idle" } : a;
  }

  available(): boolean {
    return this.ok;
  }

  forSession(harness: Harness, sessionId: string): Presence | null {
    const a = this.agents.find((x) => x.agent === harness && x.agent_session?.value === sessionId);
    return a ? toPresence(this.effective(a)) : null;
  }

  resolvePane(paneId: string): { harness: Harness; sessionId: string; cwd: string | null } | null {
    const a = this.agents.find((x) => x.pane_id === paneId);
    const harness = a?.agent as Harness | undefined;
    const sessionId = a?.agent_session?.value;
    if (!a || !harness || !HARNESSES.includes(harness) || !sessionId) return null;
    return { harness, sessionId, cwd: a.cwd ?? null };
  }

  /** Every supported agent herdr sees, whether or not it has posted to the inbox. */
  live(): LiveAgent[] {
    return this.agents.flatMap((a) => {
      const harness = a.agent as Harness | undefined;
      if (!harness || !HARNESSES.includes(harness)) return [];
      return [{
        paneId: a.pane_id,
        harness,
        sessionId: a.agent_session?.value ?? null,
        cwd: a.cwd ?? null,
        status: this.effective(a).agent_status ?? "unknown",
        title: a.terminal_title_stripped ?? null,
        name: a.name ?? null,
      }];
    });
  }

  /** Brings the pane to the front in herdr. */
  async focus(paneId: string): Promise<void> {
    await run(this.bin, ["agent", "focus", paneId], { timeout: 2500 });
  }

  /**
   * Types a prompt into the agent. herdr refuses an agent that is asking something, and waits
   * until the agent is seen working (or asking), so success means the agent took it up.
   */
  async prompt(paneId: string, text: string): Promise<void> {
    // The previous quiet screen says nothing about this new turn. Reserve it before typing.
    this.stale.reset(paneId);
    try {
      await run(this.bin, ["agent", "prompt", paneId, text, "--wait", "--until", "working", "--until", "blocked", "--timeout", "15000"], { timeout: 20_000 });
    } catch (err) {
      throw new Error(herdrError(err));
    }
  }

  async createWorktree(repoRoot: string, place: { path: string; branch: string; base: string | null; label: string }): Promise<{ paneId: string }> {
    const base = place.base ? ["--base", place.base] : [];
    const created = await this.call<{ root_pane: { pane_id: string } }>(["worktree", "create", "--cwd", repoRoot, "--branch", place.branch, ...base, "--path", place.path, "--label", place.label, "--no-focus"]);
    return { paneId: created.root_pane.pane_id };
  }

  async startAgent(paneId: string, name: string, harness: Harness, args: string[]): Promise<void> {
    // herdr types the command at once, so a pane whose shell is still loading takes only its first kilobyte (the tty's line limit) and the agent never starts.
    await run(this.bin, ["pane", "wait-output", "--regex", "\\S", "--timeout", "15000", paneId], { timeout: 20_000 }).catch(() => {});
    try {
      await this.call(["agent", "start", name, "--kind", harness, "--pane", paneId, "--timeout", "30000", "--", ...args], 40_000);
    } catch (err) {
      // Stopped at a question while starting, such as whether to trust the folder: it is running, waiting on you.
      if (!(err instanceof Error && /blocked during startup/.test(err.message))) throw err;
    }
  }

  async closePane(paneId: string): Promise<void> {
    await this.call(["pane", "close", paneId]);
  }

  /**
   * A shell pane in `cwd`, without taking focus: beside `pane` in its tab, where `nextSplit` puts
   * it so the tab stays a grid, or in a workspace of its own when there is no pane to go beside.
   */
  async openPane(cwd: string, beside: string | null, label: string): Promise<string> {
    if (!beside) {
      const created = await this.call<{ root_pane: { pane_id: string } }>(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
      return created.root_pane.pane_id;
    }
    const { layout } = await this.call<{ layout: { panes: Array<{ pane_id: string; rect: Omit<PaneRect, "id"> }> } }>(["pane", "layout", "--pane", beside]);
    const { pane, direction } = nextSplit(layout.panes.map((p) => ({ id: p.pane_id, ...p.rect })));
    const created = await this.call<{ pane: { pane_id: string } }>(["pane", "split", pane, "--direction", direction, "--ratio", "0.5", "--cwd", cwd, "--no-focus"]);
    return created.pane.pane_id;
  }

  async renameAgent(paneId: string, name: string): Promise<void> {
    await this.call(["agent", "rename", paneId, name]);
  }

  /** herdr removes a worktree through the workspace it is open in, so one not open is opened first. */
  async removeWorktree(repoRoot: string, path: string): Promise<void> {
    const listed = await this.call<{ worktrees: Array<{ path: string; open_workspace_id?: string | null }> }>(["worktree", "list", "--cwd", repoRoot]);
    let workspace = listed.worktrees.find((w) => w.path === path)?.open_workspace_id;
    if (!workspace) {
      const opened = await this.call<{ workspace: { workspace_id: string } }>(["worktree", "open", "--cwd", repoRoot, "--path", path, "--no-focus"]);
      workspace = opened.workspace.workspace_id;
    }
    await this.call(["worktree", "remove", "--workspace", workspace]);
  }

  /** Runs a herdr command and returns its result, or throws with herdr's own message. */
  private async call<T = unknown>(args: string[], timeout = 20_000): Promise<T> {
    try {
      const { stdout } = await run(this.bin, args, { timeout, maxBuffer: 2_000_000 });
      return (JSON.parse(stdout) as { result: T }).result;
    } catch (err) {
      throw new Error(herdrError(err));
    }
  }

  /** A notification inside herdr, where you are working, with its request sound. */
  async notify(title: string, body: string): Promise<void> {
    await run(this.bin, ["notification", "show", title, "--body", body, "--sound", "request"], { timeout: 2500 });
  }
}

/** herdr answers errors as JSON on stdout or stderr; the message is what a person can act on. */
/** One readable line, never a dump of herdr's output or a stack trace. */
function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^(fatal|error):\s*/i, "").slice(0, 200);
}

function herdrError(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  for (const out of [e.stdout, e.stderr]) {
    try {
      const message = (JSON.parse(out ?? "") as { error?: { message?: string } }).error?.message;
      if (message) return message;
    } catch {
      const line = firstLine(out);
      if (line) return line;
    }
  }
  return firstLine(e.message) || "herdr did not answer";
}

function fingerprint(a: HerdrAgent): string {
  return `${a.pane_id}|${a.agent}|${a.agent_session?.value}|${a.agent_status}|${a.name}|${a.cwd}`;
}

function toPresence(a: HerdrAgent): Presence {
  return {
    source: "herdr",
    paneId: a.pane_id,
    status: a.agent_status ?? "unknown",
    name: a.name ?? null,
    title: a.terminal_title_stripped ?? null,
    seenAt: new Date().toISOString(),
  };
}
