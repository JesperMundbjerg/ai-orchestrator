/**
 * What the office's answer chat opens after a question: the same agent's other questions first,
 * then the rest of the line, never the one open now or one this chat already dealt with.
 */
export function followingQuestions<E extends { item: { id: string }; task: { id: string } }>(
  waiting: E[],
  open: string | null,
  handled: readonly string[],
  asker: string | undefined,
  agentOf: ReadonlyMap<string, string>,
): E[] {
  const rest = waiting.filter((e) => e.item.id !== open && !handled.includes(e.item.id));
  const theirs = (e: E) => asker !== undefined && agentOf.get(e.task.id) === asker;
  return [...rest.filter(theirs), ...rest.filter((e) => !theirs(e))];
}
