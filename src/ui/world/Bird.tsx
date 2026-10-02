import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, ConeGeometry, Float32BufferAttribute, IcosahedronGeometry, type BufferGeometry, type Group } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { FlightPose } from "./flight.ts";

type V3 = [number, number, number];

/** A blue tit in the feeders' palette, baked into just three coloured draws. Faces -Z. */
function birdGeometry() {
  const bake = (draw: (blob: (at: V3, size: V3, color: string, cone?: boolean) => void) => void) => {
    const parts: BufferGeometry[] = [];
    draw((at, size, hex, cone = false) => {
      const source = cone ? new ConeGeometry(1, 1, 4).rotateX(-Math.PI / 2) : new IcosahedronGeometry(1, 0);
      const part = source.index ? source.toNonIndexed() : source;
      if (part !== source) source.dispose();
      part.deleteAttribute("uv");
      part.scale(...size).translate(...at);
      const color = new Color(hex), colors = new Float32Array(part.getAttribute("position").count * 3);
      for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
      part.setAttribute("color", new Float32BufferAttribute(colors, 3));
      parts.push(part);
    });
    const geometry = mergeGeometries(parts)!;
    parts.forEach(part => part.dispose());
    return geometry;
  };
  const body = bake(blob => {
    blob([0, 0, 0], [0.27, 0.3, 0.43], "#d9bd56");
    blob([0, 0.1, 0.12], [0.25, 0.24, 0.35], "#668795");
    blob([0, 0.25, -0.28], [0.24, 0.24, 0.25], "#44759c");
    blob([0, 0.38, -0.24], [0.17, 0.12, 0.19], "#679bbc");
    blob([0, 0.2, -0.55], [0.1, 0.075, 0.2], "#3b3c3a", true);
    for (const side of [-1, 1]) {
      blob([side * 0.18, 0.2, -0.34], [0.09, 0.13, 0.15], "#efe6c9");
      blob([side * 0.223, 0.27, -0.39], [0.035, 0.043, 0.037], "#252e32");
      blob([side * 0.239, 0.285, -0.408], [0.011, 0.013, 0.012], "#fff6df");
      blob([side * 0.1, -0.02, 0.5], [0.11, 0.045, 0.35], "#446984");
      blob([side * 0.12, -0.27, 0.12], [0.055, 0.035, 0.12], "#96744a");
    }
  });
  const wing = bake(blob => {
    blob([0.24, 0, 0], [0.34, 0.065, 0.25], "#5787a6");
    for (let i = 0; i < 3; i++) {
      blob([0.54 - i * 0.045, -0.006, -0.1 + i * 0.13], [0.33 - i * 0.045, 0.035, 0.09], "#3f6687");
    }
    blob([0.37, 0.04, 0.02], [0.075, 0.024, 0.22], "#e6ddbf");
  });
  return { body, wing };
}

/** Ref-driven animation: no React updates, textures, skeleton, or per-frame geometry work. */
export function Bird({ pose }: { pose: RefObject<FlightPose> }) {
  const geometry = useMemo(birdGeometry, []);
  const body = useRef<Group>(null), left = useRef<Group>(null), right = useRef<Group>(null);
  useEffect(() => () => { geometry.body.dispose(); geometry.wing.dispose(); }, [geometry]);
  useFrame(() => {
    if (!body.current || !left.current || !right.current) return;
    body.current.position.y = pose.current.bob;
    body.current.rotation.x = pose.current.lean;
    left.current.rotation.z = -pose.current.flap;
    right.current.rotation.z = pose.current.flap;
  });
  return <group ref={body}>
    <mesh geometry={geometry.body} castShadow><meshStandardMaterial vertexColors roughness={1} flatShading /></mesh>
    <group ref={left} position={[-0.19, 0.06, 0]}>
      <mesh geometry={geometry.wing} scale={[-1, 1, 1]} castShadow><meshStandardMaterial vertexColors roughness={1} flatShading /></mesh>
    </group>
    <group ref={right} position={[0.19, 0.06, 0]}>
      <mesh geometry={geometry.wing} castShadow><meshStandardMaterial vertexColors roughness={1} flatShading /></mesh>
    </group>
  </group>;
}
