// Session-only control. No terminal commands: a live integration advertises and applies it.
import { randomUUID } from "node:crypto";
import type { AgentEffort, Capabilities, EffortReport, Harness } from "../shared/types.ts";
import { InboxError } from "./inbox.ts";

interface SessionEffort { value: AgentEffort; levels: string[]; seen: number; requested: number }
const FRESH = 15_000;
export const EFFORT_TIMEOUT_MS = 30_000;
const level = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_-]{0,23}$/.test(v);

export class Efforts {
  private sessions = new Map<string, SessionEffort>();
  private key(harness: Harness, session: string) { return `${harness}:${session}`; }

  report(harness: Harness, session: string, report: EffortReport, now: number): boolean {
    if (!report || !level(report.current) || !Array.isArray(report.levels) || !report.levels.length || report.levels.length > 20 || !report.levels.every(level)) return false;
    const key = this.key(harness, session);
    const old = this.sessions.get(key);
    const before = JSON.stringify(old?.value);
    const entry = old ?? { value: { current: null, request: null }, levels: [], seen: now, requested: 0 };
    this.expire(entry, now);
    entry.value.current = report.current;
    const changedLevels = JSON.stringify(entry.levels) !== JSON.stringify(report.levels);
    entry.levels = [...new Set(report.levels)];
    entry.seen = now;
    const request = entry.value.request;
    // Only an explicit acknowledgement of this request confirms it. A coincidental level event does not.
    if (request?.state === "pending" && report.result?.id === request.id) {
      const error = (typeof report.result.error === "string" ? report.result.error.slice(0, 2000) : undefined) || (report.current !== request.level ? `Session applied ${report.current}, not ${request.level}` : undefined);
      request.state = error ? "failed" : "confirmed";
      if (error) request.error = error;
    }
    this.sessions.set(key, entry);
    return changedLevels || before !== JSON.stringify(entry.value);
  }

  view(harness: Harness, session: string | null, now: number): { capabilities: Pick<Capabilities, "changeEffort" | "effortUnavailable">; effort?: AgentEffort } {
    const entry = session ? this.sessions.get(this.key(harness, session)) : undefined;
    if (!entry) return { capabilities: harness === "claude" ? { effortUnavailable: "Effort control unavailable: the installed command also changes your defaults, not just this session." } : {} };
    this.expire(entry, now);
    return {
      capabilities: now - entry.seen < FRESH ? { changeEffort: { levels: entry.levels } } : { effortUnavailable: "Effort integration disconnected" },
      effort: structuredClone(entry.value),
    };
  }

  request(harness: Harness, session: string, wanted: unknown, now: number): AgentEffort {
    const entry = this.sessions.get(this.key(harness, session));
    if (!entry || now - entry.seen >= FRESH) throw new InboxError(409, "this session cannot change effort through a live integration");
    if (!level(wanted) || !entry.levels.includes(wanted)) throw new InboxError(400, "unsupported effort level");
    this.expire(entry, now);
    if (entry.value.request?.state === "pending") throw new InboxError(409, "an effort change is already pending");
    entry.value.request = { id: randomUUID(), level: wanted, state: "pending" };
    entry.requested = now;
    return structuredClone(entry.value);
  }

  pending(harness: Harness, session: string, now: number): { id: string; level: string } | null {
    const entry = this.sessions.get(this.key(harness, session));
    if (!entry) return null;
    this.expire(entry, now);
    const request = entry.value.request;
    return request?.state === "pending" ? { id: request.id, level: request.level } : null;
  }

  private expire(entry: SessionEffort, now: number) {
    if (entry.value.request?.state === "pending" && now - entry.requested >= EFFORT_TIMEOUT_MS) {
      entry.value.request.state = "failed";
      entry.value.request.error = "Session did not confirm the change within 30 seconds";
    }
  }
}
