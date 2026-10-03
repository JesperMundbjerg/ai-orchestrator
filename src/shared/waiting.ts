import type { Delivery, Message, Team, WorldAgent } from "./types.ts";

/** Who a delivery waits for while that agent is offline, worded for its sender; null while it runs. */
export function offlineRecipient(agent: Pick<WorldAgent, "name" | "status" | "role" | "teamId"> | undefined, teams: Array<Pick<Team, "id" | "name">>): string | null {
  if (!agent || agent.status !== "offline") return null;
  const team = agent.role === "lead" ? teams.find((t) => t.id === agent.teamId) : undefined;
  return team ? `${team.name}'s lead (${agent.name})` : agent.name;
}

/** No harness knowledge: a queued message has simply not reached its recipient, and an offline one is said to be offline, not busy. */
export function waitingLabel(message: Pick<Message, "fromAgentId" | "fromOffice" | "createdAt">, delivery: Pick<Delivery, "state" | "updatedAt" | "offline">, now = Date.now()): string | null {
  if (message.fromOffice || delivery.state !== "queued") return null;
  // Retrying starts a new wait, rather than immediately warning about the original send.
  const minutes = Math.floor((now - Math.max(Date.parse(message.createdAt), Date.parse(delivery.updatedAt))) / 60_000);
  if (delivery.offline) return minutes >= 1 ? `waiting ${minutes} min: ${delivery.offline} is offline` : `${delivery.offline} is offline`;
  if (message.fromAgentId) return null;
  return minutes >= 10 ? `waiting ${minutes} min: they seem busy` : null;
}

/** A queued delivery to an offline agent says so, so its sender reads "offline", not "busy". */
export function withOffline(messages: Message[], agents: Array<Pick<WorldAgent, "id" | "name" | "status" | "role" | "teamId">>, teams: Array<Pick<Team, "id" | "name">>): Message[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return messages.map((m) => m.deliveries.some((d) => d.state === "queued" && byId.get(d.agentId)?.status === "offline")
    ? { ...m, deliveries: m.deliveries.map((d) => {
      const offline = d.state === "queued" ? offlineRecipient(byId.get(d.agentId), teams) : null;
      return offline ? { ...d, offline } : d;
    }) }
    : m);
}
