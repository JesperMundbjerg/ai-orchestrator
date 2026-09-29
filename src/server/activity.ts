// What each agent is doing right now, the helpers (sub-agents) it has running and the model it
// runs on, from the events its harness reports: Claude Code through an HTTP hook, Pi through its
// extension. Kept in memory only: it describes the last minutes, and a restart forgets it.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import type { ActivityEvent, AgentModel, Helper } from "../shared/types.ts";

/** A tool line stops being shown this long after it was reported, in case its end never comes. */
const DOING_MS = 120_000;
/** A helper nobody hears from for this long is taken to be gone. */
const HELPER_MS = 30 * 60_000;
/** Tools that start sub-agents: Pi's fysiklab `agent` / `agents`. Claude reports its own through SubagentStart. */
const PI_HELPER_TOOLS = new Set(["agent", "agents"]);

interface Doing { text: string; at: number }
interface Running extends Helper { seen: number }
/** A model is told per session: a new session in the same checkout has not said which it runs. */
interface Told { sessionId: string | null; model: AgentModel }

export class Activity {
  private doing = new Map<string, Doing>();
  private helpers = new Map<string, Map<string, Running>>();
  private models = new Map<string, Told>();

  /** Records the model a session reports; true when it changed. */
  setModel(agentId: string, sessionId: string | null, model: AgentModel): boolean {
    const before = this.models.get(agentId);
    this.models.set(agentId, { sessionId, model });
    return before?.sessionId !== sessionId || before.model.id !== model.id || before.model.label !== model.label;
  }

  /** The model last reported, unless it was told by another session than the one running now. */
  modelOf(agentId: string, sessionId: string | null): AgentModel | null {
    const told = this.models.get(agentId);
    if (!told || (told.sessionId && sessionId && told.sessionId !== sessionId)) return null;
    return told.model;
  }

  /** Records an event; true when what the office shows changed. */
  record(agentId: string, event: ActivityEvent, now: number): boolean {
    const before = JSON.stringify(this.of(agentId, now));
    const helpers = this.helpers.get(agentId) ?? new Map<string, Running>();
    this.helpers.set(agentId, helpers);
    const startedAt = new Date(now).toISOString();
    switch (event.kind) {
      case "tool": {
        this.doing.set(agentId, { text: describeTool(event.tool ?? "", event.input ?? {}), at: now });
        if (event.callId && PI_HELPER_TOOLS.has(event.tool ?? "")) {
          const calls = Array.isArray(event.input?.calls) ? (event.input.calls as Array<{ name?: unknown }>) : [event.input ?? {}];
          calls.forEach((c, i) => {
            const id = `${event.callId}:${i}`;
            helpers.set(id, { id, type: typeof c.name === "string" ? c.name : "helper", startedAt, seen: now });
          });
        }
        break;
      }
      case "tool_end":
        if (event.callId) for (const id of helpers.keys()) if (id.startsWith(`${event.callId}:`)) helpers.delete(id);
        break;
      case "helper_start":
        if (event.helperId) helpers.set(event.helperId, { id: event.helperId, type: event.helperType || "helper", startedAt, seen: now });
        break;
      case "helper_stop":
        if (event.helperId) helpers.delete(event.helperId);
        break;
      case "model":
        // Kept per session by setModel; nothing to show here.
        break;
      case "idle":
        // A finished turn has no tool running; its helpers finished with it.
        this.doing.delete(agentId);
        helpers.clear();
        break;
    }
    return JSON.stringify(this.of(agentId, now)) !== before;
  }

  /** Keeps a helper alive while it is heard from (a Claude sub-agent's own tool calls). */
  touchHelper(agentId: string, helperId: string, now: number): void {
    const h = this.helpers.get(agentId)?.get(helperId);
    if (h) h.seen = now;
  }

  of(agentId: string, now: number): { doing: string | null; helpers: Helper[] } {
    const doing = this.doing.get(agentId);
    const helpers = [...(this.helpers.get(agentId)?.values() ?? [])]
      .filter((h) => now - h.seen < HELPER_MS)
      .map(({ seen: _, ...h }) => h);
    return { doing: doing && now - doing.at < DOING_MS ? doing.text : null, helpers };
  }
}

/** A short line for a tool call, as someone looking over the agent's shoulder would put it. */
export function describeTool(tool: string, input: Record<string, unknown>): string {
  const s = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const file = s("file_path") || s("path") || s("notebook_path");
  const short = (text: string, n = 48) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  switch (tool.toLowerCase()) {
    case "bash":
      return s("description") ? short(s("description"), 60) : `Running ${short(s("command").split("\n")[0]!)}`;
    case "edit":
    case "multiedit":
    case "write":
    case "notebookedit":
      return file ? `Editing ${basename(file)}` : "Editing";
    case "read":
      return file ? `Reading ${basename(file)}` : "Reading";
    case "grep":
    case "glob":
    case "find":
    case "ls":
      return s("pattern") ? `Searching for ${short(s("pattern"), 32)}` : "Searching";
    case "webfetch":
    case "websearch":
      return `Looking up ${short(s("query") || s("url"), 40)}`;
    case "agent":
    case "task":
      return `Briefing a helper${s("subagent_type") || s("name") ? ` (${s("subagent_type") || s("name")})` : ""}`;
    case "agents":
      return `Briefing ${Array.isArray(input.calls) ? input.calls.length : "some"} helpers`;
    case "todowrite":
      return "Planning";
    default:
      return `Using ${tool}`;
  }
}

/**
 * The events in one Claude Code hook call (the JSON Claude posts to an HTTP hook). Tool calls
 * made inside a sub-agent carry its agent_id: they keep that helper alive but are not what the
 * agent itself is doing.
 */
export function claudeHookEvents(hook: Record<string, unknown>): { events: ActivityEvent[]; helperId: string | null } {
  const name = String(hook.hook_event_name ?? "");
  const helperId = typeof hook.agent_id === "string" ? hook.agent_id : null;
  const type = typeof hook.agent_type === "string" ? hook.agent_type : undefined;
  if (name === "SubagentStart" && helperId) return { events: [{ kind: "helper_start", helperId, helperType: type }], helperId: null };
  if (name === "SubagentStop" && helperId) return { events: [{ kind: "helper_stop", helperId }], helperId: null };
  if (helperId) return { events: [], helperId };
  if (name === "PreToolUse") {
    const input = hook.tool_input && typeof hook.tool_input === "object" ? (hook.tool_input as Record<string, unknown>) : {};
    return { events: [{ kind: "tool", tool: String(hook.tool_name ?? ""), input }], helperId: null };
  }
  if (name === "Stop" || name === "SessionEnd") return { events: [{ kind: "idle" }], helperId: null };
  return { events: [], helperId: null };
}

/** "claude-opus-5-5" → "Opus 5.5"; an id in another form is shown as it is. */
export function claudeModelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!m) return id;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}${m[4] ? " (1M)" : ""}`;
}

/** How much of a transcript's end is read to find the model of its latest reply. */
const TRANSCRIPT_TAIL = 256 * 1024;

/**
 * The model a Claude Code session runs, as Claude Code itself records it: the hook input's
 * `model` when it carries one, else the model of the latest reply in its transcript. Null when
 * neither says, so nothing is guessed.
 */
export function claudeModel(hook: Record<string, unknown>): AgentModel | null {
  const given = typeof hook.model === "string" ? hook.model : null;
  const id = given ?? (typeof hook.transcript_path === "string" ? lastReplyModel(hook.transcript_path) : null);
  return id ? { id, label: claudeModelLabel(id) } : null;
}

function lastReplyModel(path: string): string | null {
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"assistant"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
      const model = entry.message?.model;
      // Claude Code writes "<synthetic>" for replies it made up itself, such as an interruption.
      if (entry.type === "assistant" && typeof model === "string" && model && !model.startsWith("<")) return model;
    } catch {
      // The first line of the tail is usually cut; any unreadable line is skipped.
    }
  }
  return null;
}
