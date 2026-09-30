import type { KeyboardEvent } from "react";

/** The hint every writing box shows, so the same keys mean the same thing everywhere. */
export const SEND_HINT = "Enter to send · Shift+Enter for a new line";

/**
 * Enter sends and Shift+Enter is a new line; ⌘/Ctrl+Enter sends too. Nothing is sent while an
 * input method is composing (Enter then confirms the candidate), and Alt+Enter is left alone.
 * Enter is always taken, so a send that has nothing to send does nothing rather than adding a
 * line: `send` decides whether it can.
 *
 * Use as `onKeyDown={sendOnEnter(send)}`; a box that handles other keys calls the handler
 * from its own `onKeyDown`.
 */
export function sendOnEnter(send: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.altKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    send();
  };
}

/** What Enter does in the answer box, by kind of item. */
export type EnterKind = "answer" | "choose" | "approve";

/**
 * Whether Enter in the answer box acts, and the hint that says so. An open question needs words
 * and a decision needs an option. A try item or milestone is approved by Enter only while the
 * note is empty (words or images): with a note typed, Enter does nothing, so a note is never
 * approved by accident and Approve or Needs changes is a click.
 */
export function enterPlan(kind: EnterKind, label: string, { text, choice, said }: { text: string; choice: string | null; said: boolean }, changes = "Needs changes") {
  const newLine = "Shift+Enter for a new line";
  if (kind === "approve" && said) {
    return { enabled: false, hint: `Type a note, then click ${label} or ${changes} · ${newLine}` };
  }
  const enabled = kind === "answer" ? Boolean(text.trim()) : kind === "choose" ? Boolean(choice) : true;
  return { enabled, hint: `Enter to ${label.toLowerCase()} · ${newLine}` };
}
