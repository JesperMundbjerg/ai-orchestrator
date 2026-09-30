import type { Message } from "../shared/types.ts";
import { waitingLabel } from "../shared/waiting.ts";

/** Log once per queued attempt, not once per poll; no message contents enter service logs. */
export class WaitingMessages {
  private warned = new Set<string>();
  check(messages: Message[], now: number, log = console.warn): void {
    const active = new Set<string>();
    for (const message of messages) for (const delivery of message.deliveries) {
      if (delivery.state !== "queued") continue;
      const key = `${message.id}/${delivery.agentId}/${delivery.updatedAt}`;
      active.add(key);
      const label = waitingLabel(message, delivery, now);
      if (label && !this.warned.has(key)) {
        this.warned.add(key);
        log(`office: founder message ${message.id} to ${delivery.agentId}: ${label}`);
      }
    }
    for (const key of this.warned) if (!active.has(key)) this.warned.delete(key);
  }
}
