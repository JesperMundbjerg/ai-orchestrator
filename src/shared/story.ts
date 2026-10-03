// The agent invents its own story; the office only asks for it and keeps plain text.
export const STORY_MAX_CHARS = 800;
/**
 * Which prompt a story answers. Stories saved before this were job backstories under the first
 * prompt; the office asks those agents once to retell theirs, then keeps whatever they have.
 */
export const STORY_PROMPT = 2;
export const STORY_INTRO = 'Quick, one-off office introduction, not part of your task: in 3–5 sentences, in your own voice, tell your personal life story — not your job, skills or duties, but who you are: a childhood memory that made you happy, a crisis you came through, what you love or fear. `inbox team` tells you your office name; save it once with inbox story "…" (plain text, at most 800 characters). If you already told your personal story, skip this.';
/** The agent's own story, shown back to it in its briefing so the person it is shows in its work. */
export const storyLine = (story: string) => `Your story: ${story} Let that person show in your work: your own creativity and a personal touch, not only the task.`;
