// Advisory only: deterministic observations of stored messages, never a gate on sending.
// Pair state is durable so restarting the office neither forgets a streak nor repeats a notice.
import type { DatabaseSync } from "node:sqlite";
import type { Message } from "../shared/types.ts";

// Four round trips in ten minutes, all under 300 characters, is enough to nudge a likely
// acknowledgment loop without treating a one-way burst or substantive work as a loop.
const TRIP = 8;
const WINDOW_MS = 10 * 60_000;
const SHORT_CHARS = 300;
type Episode = { sender_id: string; last_at: number; recent: string; warned: number };
export type LoopNotice = { agentIds: [string, string]; text: string; escalate?: true };
const ESCALATION_MS = 30 * 60_000;

export class MessageLoops {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Called inside the message's transaction, once per new message (not per delivery or Retry). */
  observe(message: Message): LoopNotice | null {
    const from = message.fromAgentId;
    // Founder/office messages, including our own notice, cannot feed back into the detector.
    if (!from || message.fromOffice || message.toFounder) return null;
    const at = Date.parse(message.createdAt);
    const cutoff = at - WINDOW_MS;
    this.db.prepare("DELETE FROM message_loops WHERE last_at < ?").run(cutoff);
    const to = [...new Set(message.deliveries.map((d) => d.agentId))].filter((id) => id !== from);
    const pair = (recipient: string) => JSON.stringify([from, recipient].sort());
    const short = message.kind === "message" && message.text.length < SHORT_CHARS && !message.images.length && to.length === 1;
    if (!short) {
      // Work, longer text, images and group exchanges end the affected pair's episode.
      for (const recipient of to) this.db.prepare("DELETE FROM message_loops WHERE pair = ?").run(pair(recipient));
      return null;
    }
    const key = pair(to[0]!);
    const previous = this.db.prepare("SELECT * FROM message_loops WHERE pair = ?").get(key) as Episode | undefined;
    // A repeated sender breaks the alternating streak, but does not rearm a warned episode.
    // Only ten minutes of pair silence or substantive work rearms it, not a sliding window.
    const recent: number[] = previous && previous.sender_id !== from
      ? (JSON.parse(previous.recent) as number[]).filter((t) => t >= cutoff)
      : [];
    recent.push(at);
    const streak = recent.slice(-TRIP);
    const trip = !previous?.warned && streak.length >= TRIP;
    this.db.prepare(`INSERT INTO message_loops (pair, sender_id, last_at, recent, warned) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pair) DO UPDATE SET sender_id = excluded.sender_id, last_at = excluded.last_at, recent = excluded.recent, warned = excluded.warned`)
      .run(key, from, at, JSON.stringify(streak), previous?.warned || (trip ? 1 : 0));
    if (!trip) return null;
    const minutes = Math.max(1, Math.ceil((at - streak[0]!) / 60_000));
    // Keep recurrence separately: ending an acknowledgment episode must not erase its last trip.
    const last = this.db.prepare("SELECT last_at, escalated FROM message_loop_trips WHERE pair = ?").get(key) as { last_at: number; escalated: number } | undefined;
    const recurring = !!last && at - last.last_at <= ESCALATION_MS;
    const escalate = recurring && !last.escalated;
    this.db.prepare(`INSERT INTO message_loop_trips (pair, last_at, escalated) VALUES (?, ?, ?)
      ON CONFLICT(pair) DO UPDATE SET last_at = excluded.last_at, escalated = excluded.escalated`)
      .run(key, at, recurring ? 1 : 0);
    return {
      ...(escalate ? { escalate: true as const } : {}),
      agentIds: JSON.parse(key) as [string, string],
      text: `You two have traded ${streak.length} short messages in ${minutes} ${minutes === 1 ? "minute" : "minutes"}; stop replying to acknowledgments, continue the work.`,
    };
  }
}
