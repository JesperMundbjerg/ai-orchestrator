// A definite refusal before typing, unlike a timeout or interrupted confirmation which may
// already have submitted the prompt. Only this failure is safe to queue automatically.
export class AgentStartingError extends Error {}

export function agentIsStarting(message: string): boolean {
  return /^agent \S+ is not an active named agent[.!]?$/i.test(message.trim());
}
