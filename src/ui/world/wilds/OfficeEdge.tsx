import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import type { Group } from "three";
import type { Rect } from "../building.ts";
import { away } from "./land.ts";

/** Keep the office intact, but don't submit its furniture/shadows once it is behind the fog. */
export function OfficeEdge({ bounds, children }: { bounds: Rect; children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    if (group.current) group.current.visible = away(bounds, camera.position.x, camera.position.z) < 112;
  }, -0.75);
  return <group ref={group}>{children}</group>;
}
