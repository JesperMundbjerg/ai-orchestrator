import { createContext, useContext, useEffect } from "react";
import { addAfterEffect, useFrame, useThree } from "@react-three/fiber";
import { Pacer } from "./pace.ts";

/** The office's pacer, for whatever moves in it to say so. */
export const PaceContext = createContext<Pacer | null>(null);

export const usePace = () => useContext(PaceContext);

/**
 * Draws the office at the pacer's rate: the canvas renders on demand, and after each frame this
 * asks for the next one when it is due. A hidden tab asks for none until it is shown again, and
 * neither does an office under a modal dialog (its backdrop spans the view and the office is inert),
 * so a heavy modal such as the pipeline editor keeps the main thread to itself.
 */
export function Pace({ pacer }: { pacer: Pacer }) {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      const wait = pacer.nextFrameIn(performance.now(), document.visibilityState === "visible");
      if (wait !== null) timer = setTimeout(() => invalidate(), wait);
    };
    const off = addAfterEffect(() => {
      pacer.drew(performance.now());
      schedule();
    });
    const shown = () => (document.visibilityState === "visible" ? invalidate() : clearTimeout(timer));
    document.addEventListener("visibilitychange", shown);
    // Modal dialogs open and close by an attribute anywhere under the body; one query per change is cheap.
    const covering = () => {
      if (pacer.cover(document.querySelector("dialog:modal") !== null)) invalidate();
      else if (pacer.covered) clearTimeout(timer);
    };
    const modals = new MutationObserver(covering);
    modals.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    covering();
    invalidate();
    return () => {
      off();
      clearTimeout(timer);
      modals.disconnect();
      pacer.cover(false);
      document.removeEventListener("visibilitychange", shown);
      gl.shadowMap.autoUpdate = true;
    };
  }, [pacer, gl, invalidate]);

  useFrame(() => {
    if (pacer.shadowsDue(performance.now())) gl.shadowMap.needsUpdate = true;
  });
  return null;
}
