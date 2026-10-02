import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type ReactNode } from "react";
import { Box3, Frustum, Matrix4, Vector3, type Group } from "three";
import type { Rect } from "../building.ts";
import { away } from "./land.ts";

/** Keep the office intact, but don't submit its furniture/shadows once it is behind the fog. */
export function OfficeEdge({ bounds, children }: { bounds: Rect; children: ReactNode }) {
  const group = useRef<Group>(null);
  const box = useMemo(() => new Box3(new Vector3(bounds.minX - 8, -2, bounds.minZ - 8), new Vector3(bounds.maxX + 8, 24, bounds.maxZ + 8)), [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ]);
  const frustum = useRef(new Frustum()), projection = useRef(new Matrix4());
  useFrame(({ camera }) => {
    if (!group.current) return;
    const distance = away(bounds, camera.position.x, camera.position.z);
    // The wilds don't receive office shadows. Once outside, no need to redraw an entire
    // office shadow map behind the player. Keep indoor shadow casters, even behind the view.
    camera.updateMatrixWorld();
    frustum.current.setFromProjectionMatrix(projection.current.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    group.current.visible = distance < 112 && (distance < 8 || frustum.current.intersectsBox(box));
  }, -0.75);
  return <group ref={group} name="Office — visibility gate">{children}</group>;
}
