import type { Delivery, Message } from "./types.ts";

/** No harness knowledge: a founder's queued message has simply not reached its recipient. */
export function waitingLabel(message: Pick<Message, "fromAgentId" | "fromOffice" | "createdAt">, delivery: Pick<Delivery, "state" | "updatedAt">, now = Date.now()): string | null {
  if (message.fromAgentId || message.fromOffice || delivery.state !== "queued") return null;
  // Retrying starts a new wait, rather than immediately warning about the original send.
  const minutes = Math.floor((now - Math.max(Date.parse(message.createdAt), Date.parse(delivery.updatedAt))) / 60_000);
  return minutes >= 10 ? `waiting ${minutes} min: they seem busy` : null;
}
