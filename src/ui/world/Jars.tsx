import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { CylinderGeometry, type Mesh } from "three";
import type { UsageView } from "../../shared/types.ts";
import type { Corner } from "./layout.ts";
import { hash } from "./crafts.ts";
import { JAR, jarSpots, settleFill, type JarLook } from "./jars.ts";
import { textTexture } from "./label.ts";
import { usePace } from "./Pace.tsx";
import { seedGrain } from "./Seed.tsx";

const ROUND = new CylinderGeometry(1, 1, 1, 14);
const LIDS = ["#668a85", "#aa795b", "#7585a4", "#98815c"];

/** One pair per project, not per crew member. Shared low-poly glass and seed geometry. */
export function Jars({ corners, usage }: { corners: Corner[]; usage: UsageView | undefined }) {
  return <group>{jarSpots(corners, usage).map((s) => (
    <group key={s.teamId} position={[s.pos[0], 0, s.pos[1]]} rotation-y={s.facing}>
      <mesh position={[0, 0.855, 0]} receiveShadow>
        <boxGeometry args={[0.78, 0.05, 0.36]} />
        <meshStandardMaterial color="#c8a171" roughness={0.7} />
      </mesh>
      <mesh geometry={ROUND} position={[0, 0.42, 0]} scale={[0.04, 0.84, 0.04]}>
        <meshStandardMaterial color="#8a6a4a" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.025, 0]}>
        <boxGeometry args={[0.48, 0.05, 0.3]} />
        <meshStandardMaterial color="#8a6a4a" roughness={0.8} />
      </mesh>
      {s.jars.map((look, i) => <Jar key={look.id} look={look} x={(i - (s.jars.length - 1) / 2) * JAR.spacing} />)}
    </group>
  ))}</group>;
}

function Jar({ look, x }: { look: JarLook; x: number }) {
  const pace = usePace();
  const fill = useRef<Mesh>(null);
  const shown = useRef(look.fill);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tag = useMemo(() => textTexture([{ text: look.label, size: 36, color: "#302a23", weight: 700 }],
    { width: 384, height: 96, background: "#f5e8cf", radius: 12 }), [look.label]);
  const width = Math.max(700, look.text.length * 20 + 50);
  const detail = useMemo(() => textTexture([{ text: look.text, size: 36, color: "#ffffff", weight: 600 }],
    { width, height: 76, background: "rgba(16,20,28,0.9)", radius: 18 }), [look.text, width]);
  useEffect(() => () => tag.dispose(), [tag]);
  useEffect(() => () => detail.dispose(), [detail]);
  useFrame((_, delta) => {
    if (shown.current === look.fill || !fill.current) return;
    shown.current = settleFill(shown.current, look.fill, delta);
    fill.current.visible = shown.current > 0;
    fill.current.scale.y = JAR.height * shown.current;
    fill.current.position.y = JAR.height * shown.current / 2;
    pace?.moved(performance.now());
  });
  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true); };
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta < 6) setPinned((p) => !p);
  };
  const r = JAR.radius;
  const h = JAR.height;
  return (
    <group position={[x, JAR.base, 0]} name={`usage-jar:${look.id}`} userData={{ text: look.text, tokens: look.tokens, targetFill: look.fill }}>
      <group onPointerOver={over} onPointerOut={() => setHovered(false)} onClick={click}>
        <mesh ref={fill} geometry={ROUND} visible={shown.current > 0} position={[0, h * shown.current / 2, 0]} scale={[r * 0.92, h * shown.current, r * 0.92]}>
          <meshStandardMaterial map={seedGrain()} roughness={1} />
        </mesh>
        <mesh geometry={ROUND} position={[0, h / 2, 0]} scale={[r, h, r]}>
          <meshStandardMaterial color="#d6e8ee" transparent opacity={0.28} roughness={0.08} depthWrite={false} />
        </mesh>
        {/* Two narrow glints keep an empty glass legible without costly transmission. */}
        {[-1, 1].map((side) => <mesh key={side} geometry={ROUND} position={[side * r * 0.94, h / 2, -r * 0.25]} scale={[0.004, h, 0.004]}>
          <meshBasicMaterial color="#e4f3f6" transparent opacity={0.55} depthWrite={false} />
        </mesh>)}
        <mesh geometry={ROUND} position={[0, 0, 0]} scale={[r, 0.016, r]}>
          <meshStandardMaterial color="#b6d0d5" transparent opacity={0.65} roughness={0.15} />
        </mesh>
        <mesh geometry={ROUND} position={[0, h + 0.014, 0]} scale={[r * 1.06, 0.028, r * 1.06]}>
          <meshStandardMaterial color={LIDS[hash(look.id) % LIDS.length]} roughness={0.65} />
        </mesh>
        <sprite position={[0, h + 0.095, 0]} scale={[0.34, 0.085, 1]}>
          <spriteMaterial map={tag} transparent depthWrite={false} />
        </sprite>
      </group>
      {hovered || pinned ? <sprite name="jar-detail" position={[0, h + 0.34, 0]} scale={[width / 76 * 0.17, 0.17, 1]}>
        <spriteMaterial map={detail} transparent depthWrite={false} depthTest={false} fog={false} />
      </sprite> : null}
    </group>
  );
}
