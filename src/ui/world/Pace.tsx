import { createContext, useContext, useEffect } from "react";
import { addAfterEffect, useFrame, useThree } from "@react-three/fiber";
import { Pacer } from "./pace.ts";

/** The office's pacer, for whatever moves in it to say so. */
export const PaceContext = createContext<Pacer | null>(null);

export const usePace = () => useContext(PaceContext);

/**
 * Draws the office at the pacer's rate: the canvas renders on demand, and after each frame this
 * asks for the next one when it is due. A hidden tab asks for none until it is shown again.
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
    invalidate();
    return () => {
      off();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
      gl.shadowMap.autoUpdate = true;
    };
  }, [pacer, gl, invalidate]);

  useFrame(() => {
    if (pacer.shadowsDue(performance.now())) gl.shadowMap.needsUpdate = true;
  });
  return null;
}
