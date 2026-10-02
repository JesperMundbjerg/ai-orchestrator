import { useEffect, useMemo, useRef, type RefObject } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { Color, ConeGeometry, Float32BufferAttribute, IcosahedronGeometry, PlaneGeometry, ShaderMaterial, Vector3, type BufferGeometry, type Group } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { FlightPose } from "./flight.ts";
import type { Rect } from "./building.ts";
import { walkingHeight } from "./wilds/land.ts";

type V3 = [number, number, number];

/** A round robin: russet bib, cream belly, bright eyes and a short feather fan. Faces -Z.
 * Baked vertex colours keep the office's faceted style; only the wrists and shoulders move.
 */
function birdGeometry() {
  const bake = (draw: (blob: (at: V3, size: V3, color: string, cone?: boolean, yaw?: number) => void) => void) => {
    const parts: BufferGeometry[] = [];
    draw((at, size, hex, cone = false, yaw = 0) => {
      const source = cone ? new ConeGeometry(1, 1, 4).rotateX(-Math.PI / 2) : new IcosahedronGeometry(1, 0);
      const part = source.index ? source.toNonIndexed() : source;
      if (part !== source) source.dispose();
      part.deleteAttribute("uv");
      part.scale(...size).rotateY(yaw).translate(...at);
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
    blob([0, 0, 0], [0.32, 0.34, 0.37], "#eee0bd");
    blob([0, 0.1, 0.08], [0.31, 0.28, 0.34], "#82634b");
    blob([0, 0.08, -0.2], [0.28, 0.3, 0.24], "#d7773e");
    blob([0, 0.32, -0.24], [0.255, 0.255, 0.25], "#947153");
    blob([0, 0.25, -0.41], [0.19, 0.17, 0.105], "#e4924d");
    blob([0, 0.28, -0.53], [0.065, 0.05, 0.16], "#493a30", true);
    for (const side of [-1, 1]) {
      blob([side * 0.212, 0.35, -0.34], [0.059, 0.067, 0.055], "#f3dfb4");
      blob([side * 0.246, 0.355, -0.355], [0.036, 0.045, 0.036], "#252821");
      blob([side * 0.261, 0.374, -0.375], [0.012, 0.014, 0.013], "#fff9e7");
      // Tucked feet, not a dangling walker silhouette.
      blob([side * 0.12, -0.27, 0.12], [0.045, 0.033, 0.105], "#a77348");
    }
    for (let i = -2; i <= 2; i++) {
      blob([i * 0.074, -0.025, 0.47 - Math.abs(i) * 0.025], [0.066, 0.034, 0.25], i % 2 ? "#795640" : "#644b3b", false, i * 0.2);
      blob([i * 0.113, -0.014, 0.64 - Math.abs(i) * 0.035], [0.064, 0.027, 0.065], "#bd9566", false, i * 0.2);
    }
  });
  const wing = bake(blob => {
    blob([0.22, 0, 0.015], [0.29, 0.072, 0.235], "#85634a");
    blob([0.26, 0.045, 0.07], [0.2, 0.032, 0.115], "#b28a5e");
  });
  // Separate primaries overlap the wrist so folding never opens a visible gap.
  const tip = bake(blob => {
    for (let i = 0; i < 4; i++) {
      blob([0.17 - i * 0.025, -0.006, -0.11 + i * 0.09], [0.27 - i * 0.025, 0.032, 0.068], i % 2 ? "#71513d" : "#604936", false, -i * 0.13);
    }
    blob([0.08, 0.029, 0.015], [0.055, 0.023, 0.18], "#d7b884");
  });
  return { body, wing, tip };
}

/** Ref-driven animation: no React updates, textures, skeleton, or per-frame mesh creation. */
export function Bird({ pose, bounds }: { pose: RefObject<FlightPose>; bounds: Rect }) {
  const scene = useThree(s => s.scene);
  const geometry = useMemo(birdGeometry, []);
  // The office shadow map is deliberately only 5 Hz. Do not cast into it: these
  // three soft lobes project the actual animated transforms on EVERY drawn frame.
  // No second clock, shadow camera, render target or office-wide shadow refresh.
  const shadow = useMemo(() => ({
    lobes: [new PlaneGeometry(1, 1), new PlaneGeometry(1, 1), new PlaneGeometry(1, 1)],
    a: new Vector3(), b: new Vector3(),
    material: new ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { opacity: { value: 0.2 } },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float opacity;
        void main() { float r = length(vUv * 2.0 - 1.0);
          gl_FragColor = vec4(0.16, 0.12, 0.08, opacity * (1.0 - smoothstep(0.2, 1.0, r))); }`,
    }),
  }), []);
  const body = useRef<Group>(null), left = useRef<Group>(null), right = useRef<Group>(null);
  const leftTip = useRef<Group>(null), rightTip = useRef<Group>(null);
  useEffect(() => () => {
    Object.values(geometry).forEach(part => part.dispose());
    shadow.lobes.forEach(part => part.dispose());
    shadow.material.dispose();
  }, [geometry, shadow]);
  useFrame(() => {
    if (!body.current || !left.current || !right.current || !leftTip.current || !rightTip.current) return;
    body.current.position.y = pose.current.bob;
    body.current.rotation.x = pose.current.lean;
    left.current.rotation.z = -pose.current.flap;
    right.current.rotation.z = pose.current.flap;
    // Mirroring the left wing also mirrors its wrist: both tips sweep back on recovery.
    leftTip.current.rotation.y = rightTip.current.rotation.y = -pose.current.fold;
    body.current.updateWorldMatrix(true, true);
    const size = shadow.a.setFromMatrixScale(body.current.matrixWorld).x;
    const project = (index: number, width: number) => {
      const { a, b } = shadow;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      const ux = length > 0.00001 ? dx / length : 1, uz = length > 0.00001 ? dz / length : 0;
      const lobe = shadow.lobes[index]!, vertices = lobe.getAttribute("position"), uv = lobe.getAttribute("uv");
      for (let i = 0; i < vertices.count; i++) {
        const along = (uv.getX(i) - 0.5) * (length + width * size);
        const across = (0.5 - uv.getY(i)) * width * size;
        const x = (a.x + b.x) / 2 + along * ux - across * uz;
        const z = (a.z + b.z) / 2 + along * uz + across * ux;
        vertices.setXYZ(i, x, walkingHeight(x, z, bounds) + 0.065, z);
      }
      vertices.needsUpdate = true;
    };
    body.current.localToWorld(shadow.a.set(0, 0, -0.2));
    body.current.localToWorld(shadow.b.set(0, 0, 0.26));
    const altitude = shadow.a.y - walkingHeight(shadow.a.x, shadow.a.z, bounds);
    // No giant aerial shadow at overview height; softly disappear instead.
    shadow.material.uniforms.opacity!.value = 0.22 * Math.max(0, Math.min(1, (10 - altitude) / 7));
    project(0, 0.55);
    left.current.localToWorld(shadow.a.set(0, 0, 0));
    leftTip.current.localToWorld(shadow.b.set(0.36, 0, 0));
    project(1, 0.3);
    right.current.localToWorld(shadow.a.set(0, 0, 0));
    rightTip.current.localToWorld(shadow.b.set(0.36, 0, 0));
    project(2, 0.3);
  });
  return <><group ref={body}>
    <mesh geometry={geometry.body}><meshStandardMaterial vertexColors roughness={1} flatShading /></mesh>
    {([-1, 1] as const).map(side => <group key={side} ref={side < 0 ? left : right} position={[side * 0.19, 0.08, 0]} scale={[side, 1, 1]}>
      <mesh geometry={geometry.wing}><meshStandardMaterial vertexColors roughness={1} flatShading /></mesh>
      <group ref={side < 0 ? leftTip : rightTip} position={[0.43, 0, 0]}>
        <mesh geometry={geometry.tip}><meshStandardMaterial vertexColors roughness={1} flatShading /></mesh>
      </group>
    </group>)}
  </group>
    {createPortal(<group name="founder-bird-shadow">
      {shadow.lobes.map((lobe, i) => <mesh key={i} geometry={lobe} material={shadow.material} frustumCulled={false} raycast={() => {}} />)}
    </group>, scene)}
  </>;
}
