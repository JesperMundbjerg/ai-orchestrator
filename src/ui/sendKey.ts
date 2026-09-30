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
