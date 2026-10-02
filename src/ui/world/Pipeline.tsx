import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { Vec2 } from "./spatial.ts";

const CHEVRON_GAP = 0.9;

/** Arrows on the floor flowing from one team to the team it hands its work to; brighter while work is in review. */
export function Pipeline({ path, busy }: { path: Vec2[]; busy: boolean }) {
  const segments = useMemo(() => path.slice(1).map((p, i) => {
    const a = path[i]!;
    return { a, dx: p[0] - a[0], dz: p[1] - a[1], len: Math.hypot(p[0] - a[0], p[1] - a[1]) };
  }), [path]);
  const total = segments.reduce((s, x) => s + x.len, 0);
  const count = Math.max(1, Math.floor(total / CHEVRON_GAP));
  const chevrons = useRef<Array<Group | null>>([]);

  useFrame((state) => {
    const shift = (state.clock.elapsedTime * (busy ? 1.2 : 0.5)) % CHEVRON_GAP;
    for (let i = 0; i < count; i++) {
      const g = chevrons.current[i];
      if (!g) continue;
      let d = i * CHEVRON_GAP + shift;
      let seg = segments[0]!;
      for (const s of segments) {
        seg = s;
        if (d <= s.len) break;
        d -= s.len;
      }
      const t = Math.min(1, d / seg.len);
      g.position.set(seg.a[0] + seg.dx * t, 0.012, seg.a[1] + seg.dz * t);
      g.rotation.y = Math.atan2(-seg.dz, seg.dx);
    }
  });

  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <group key={i} ref={(g) => void (chevrons.current[i] = g)}>
          <mesh rotation-x={-Math.PI / 2}>
            <circleGeometry args={[0.2, 3]} />
            <meshBasicMaterial color={busy ? "#3b6fe0" : "#7d8fa8"} transparent opacity={busy ? 0.85 : 0.5} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
