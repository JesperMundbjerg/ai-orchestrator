/** The agent's own note, rendered as text only; no placeholder while it has none. */
export function AgentStory({ story }: { story?: string | null }) {
  return story ? <p className="agent-story" aria-label="Office story">{story}</p> : null;
}
