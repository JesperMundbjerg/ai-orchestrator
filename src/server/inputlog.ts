// A diagnostic input log: the UI's opt-in recorder (`?inputlog=1`, src/ui/inputlog.ts) posts batches of
// keyboard, paste, focus and long-task events here, kept in memory only and never written to disk.
// Events carry lengths and types, never typed or dictated text; strings are cut short as a second guard.
import { ValidationError, type Schema } from "../shared/agent-protocol.ts";

export const INPUTLOG_CAPACITY = 5000;
export const INPUTLOG_BATCH_LIMIT = 2500;
const STRING_LIMIT = 120;
const FIELD_LIMIT = 40;

export type InputLogEvent = Record<string, string | number | boolean | null | string[]>;

function cleanValue(v: unknown): string | number | boolean | null | string[] | undefined {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.slice(0, STRING_LIMIT);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, STRING_LIMIT));
  return undefined;
}

/** `{ events: [{ t, kind, ... }] }`; nested objects are dropped, strings cut to 120 characters. */
export const inputLogBatchSchema: Schema<{ events: InputLogEvent[] }> = {
  parse(input) {
    const events = (input as { events?: unknown } | null)?.events;
    if (!Array.isArray(events)) throw new ValidationError("events", "must be a list");
    if (events.length > INPUTLOG_BATCH_LIMIT) throw new ValidationError("events", `at most ${INPUTLOG_BATCH_LIMIT} per batch`);
    return {
      events: events.map((e, i) => {
        if (!e || typeof e !== "object" || Array.isArray(e)) throw new ValidationError(`events.${i}`, "must be an object");
        const kind = (e as { kind?: unknown }).kind;
        if (typeof kind !== "string" || !kind) throw new ValidationError(`events.${i}.kind`, "must be a non-empty string");
        const out: InputLogEvent = {};
        for (const [k, v] of Object.entries(e).slice(0, FIELD_LIMIT)) {
          const clean = cleanValue(v);
          if (clean !== undefined) out[k.slice(0, 40)] = clean;
        }
        return out;
      }),
    };
  },
};

export class InputLog {
  private events: (InputLogEvent & { seq: number; receivedAt: number })[] = [];
  private seq = 0;
  readonly capacity: number;
  constructor(capacity = INPUTLOG_CAPACITY) { this.capacity = capacity; }

  add(batch: InputLogEvent[], now = Date.now()): { accepted: number; total: number } {
    for (const e of batch) this.events.push({ ...e, seq: ++this.seq, receivedAt: now });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return { accepted: batch.length, total: this.seq };
  }

  /** The newest events (at most `capacity`), oldest first; `dropped` counts those pushed out. */
  read(): { capacity: number; total: number; dropped: number; events: InputLogEvent[] } {
    return { capacity: this.capacity, total: this.seq, dropped: this.seq - this.events.length, events: [...this.events] };
  }
}
