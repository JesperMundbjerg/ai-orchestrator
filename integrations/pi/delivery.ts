// Pi 0.86.0 sendUserMessage is void/fire-and-forget. A send attempt is NOT a receipt.
// Persist attempts before sending; observe user message_end or a saved user message before ack.
// Unobserved attempts stay uncertain across reloads: never guess or automatically replay them.
export const DELIVERY_ENTRY = "review-inbox-delivery-v1";
type Phase = "attempt" | "received" | "failed" | "retryable";
interface DeliveryState { sessionId: string; id: string; phase: Phase; text: string; error?: string }
export interface ReceiptMessage { role: string; content?: unknown }

function messageText(message: ReceiptMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  return message.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

export class Deliveries {
  private states = new Map<string, DeliveryState>();
  private sessionId: string;
  private persist: (type: string, data: unknown) => void;

  constructor(sessionId: string, entries: readonly unknown[], persist: (type: string, data: unknown) => void) {
    this.sessionId = sessionId;
    this.persist = persist;
    for (const raw of entries) {
      const e = raw as { type?: string; customType?: string; data?: DeliveryState; message?: ReceiptMessage };
      if (e?.type === "custom" && e.customType === DELIVERY_ENTRY) {
        const s = e.data;
        if (s?.sessionId === sessionId && typeof s.id === "string" && typeof s.text === "string" && ["attempt", "received", "failed", "retryable"].includes(s.phase)) this.states.set(s.id, s);
      } else if (e?.type === "message" && e.message) {
        // Covers a crash after Pi persisted receipt but before our receipt journal was written.
        const text = messageText(e.message);
        for (const [id, s] of this.states) if (s.phase === "attempt" && s.text === text) this.states.set(id, { ...s, phase: "received" });
      }
    }
  }

  private save(state: DeliveryState): void {
    this.persist(DELIVERY_ENTRY, state); // If durability fails, do not send or ack.
    this.states.set(state.id, state);
  }

  attempt(id: string, body: string): string | null {
    const prior = this.states.get(id);
    if (prior && prior.phase !== "retryable") return null;
    const text = `[Review inbox delivery: ${id}]\n${body}`;
    this.save({ sessionId: this.sessionId, id, text, phase: "attempt" });
    return text;
  }

  observe(message: ReceiptMessage): void {
    const text = messageText(message);
    for (const state of this.states.values()) {
      if (state.phase === "attempt" && state.text === text) this.save({ ...state, phase: "received" });
    }
  }

  failed(id: string, error: string): void {
    const state = this.states.get(id);
    if (state?.phase === "attempt") this.save({ ...state, phase: "failed", error });
  }

  /** Undefined means no observed receipt and no definite failure: leave the service uncertain. */
  acknowledgement(id: string): { error?: string } | undefined {
    const state = this.states.get(id);
    return state?.phase === "received" ? {} : state?.phase === "failed" ? { error: state.error } : undefined;
  }

  acknowledged(id: string): void {
    const state = this.states.get(id);
    // A definite pre-receipt failure may be explicitly retried by the user (same delivery id).
    if (state?.phase === "failed") this.save({ ...state, phase: "retryable" });
    // Keep successful receipts forever in this session, including after lost-ack retries/reload.
  }
}
