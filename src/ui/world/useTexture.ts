import { useEffect, useMemo } from "react";
import type { Texture } from "three";

/** A texture made once per key and disposed when replaced. */
export function useTexture(make: () => Texture, deps: unknown[]): Texture {
  const texture = useMemo(make, deps);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
