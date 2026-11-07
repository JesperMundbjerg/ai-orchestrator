import { useLayoutEffect, useRef, type ChangeEvent } from "react";

/**
 * What to do when a writing box and the words held for it differ. `agreed` is what both last
 * said. Words that reached the box without an input event (a dictation app or the macOS
 * Accessibility API setting its value) are adopted; words changed in code (cleared after a
 * send) are written to the box. If both changed, the box wins: those are words just spoken.
 */
export function reconcileBox(box: string, held: string, agreed: string): { adopt: string } | { write: string } | null {
  if (box === held) return null;
  if (box === agreed) return { write: held };
  return { adopt: box };
}

/**
 * Props for a chat textarea. The box is uncontrolled, so the office re-rendering several times
 * a second never puts back an older value over words that arrived without an input event; each
 * render, and focus, keys and selection, reconcile the box with `text`. Send reads `text` as usual.
 */
export function useWritingBox(text: string, setText: (text: string) => void) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const agreed = useRef(text);
  const sync = () => {
    const box = ref.current;
    if (!box) return;
    const step = reconcileBox(box.value, text, agreed.current);
    if (!step) agreed.current = text;
    else if ("write" in step) agreed.current = box.value = step.write;
    else {
      agreed.current = step.adopt;
      setText(step.adopt);
    }
  };
  useLayoutEffect(sync);
  return {
    ref,
    defaultValue: text,
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
      agreed.current = e.target.value;
      setText(e.target.value);
    },
    onFocus: sync,
    onKeyUp: sync,
    onSelect: sync,
  };
}
