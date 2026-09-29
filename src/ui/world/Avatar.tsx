import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { Group, Mesh, MeshBasicMaterial, Texture } from "three";
import type { ItemType, WorldAgent } from "../../shared/types.ts";
import { HARNESS_INFO } from "../../shared/harnesses.ts";
import { textTexture } from "./label.ts";
import { LAMP } from "./status.ts";
import { lookFor, type Look } from "./look.ts";
import { route, type Spot, type Vec2 } from "./layout.ts";

const WALK_SPEED = 1.9;
const TURN_RATE = 8;

export const CARD: Record<ItemType, { color: string; glyph: string }> = {
  decide: { color: "#8a4fd8", glyph: "?" },
  try: { color: "#0f8a6c", glyph: "▶" },
  milestone: { color: "#c26a12", glyph: "✓" },
};

interface Props {
  agent: WorldAgent;
  spot: Spot;
  /** Where a newly arrived agent first appears; null places it straight at its spot. */
  enterFrom: Vec2 | null;
  waiting: { count: number; type: ItemType } | null;
  selected: boolean;
  onSelect: (id: string) => void;
  /** What they are saying; shown once they stand still, so a visitor says it on arrival. */
  bubble: string | null;
  /** A folder in hand, for work being handed over. */
  carrying: boolean;
  /** How to walk in this office: round the ring, or along the building's walkway. */
  walk?: (from: Vec2, fromSpot: Spot | null, to: Spot) => Vec2[];
}

export function Avatar({ agent, spot, enterFrom, waiting, selected, onSelect, bubble, carrying, walk = route }: Props) {
  const look = useMemo(() => lookFor(agent.id), [agent.id]);
  const root = useRef<Group>(null);
  const legs = useRef<[Group | null, Group | null]>([null, null]);
  const arms = useRef<[Group | null, Group | null]>([null, null]);
  const lamp = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const speech = useRef<Group>(null);
  const motion = useRef({
    pos: [...(enterFrom ?? spot.pos)] as Vec2,
    yaw: spot.facing,
    path: enterFrom ? walk(enterFrom, null, spot) : ([] as Vec2[]),
    spot,
    phase: Math.random() * 10,
  });
  const [hovered, setHovered] = useState(false);

  // A new spot sends the avatar walking there from wherever it is now.
  useEffect(() => {
    const m = motion.current;
    if (m.spot.pos[0] === spot.pos[0] && m.spot.pos[1] === spot.pos[1] && m.spot.group === spot.group) return;
    m.path = walk(m.pos, m.spot, spot);
    m.spot = spot;
  }, [spot]);

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "";
    return () => void (document.body.style.cursor = "");
  }, [hovered]);

  // Up close at your desk the full board would fill the view, and the card there names them already.
  const close = spot.zone === "caller";
  const tag = useMemo(() => {
    if (close) return textTexture([{ text: agent.name, size: 46, color: "#ffffff", weight: 700 }], { width: 320, height: 80, background: "rgba(16,20,28,0.72)", radius: 40 });
    const sub = [agent.project, HARNESS_INFO[agent.harness].label].filter(Boolean).join(" · ");
    return textTexture(
      [
        { text: agent.name, size: 46, color: "#ffffff", weight: 700 },
        waiting
          ? { text: `waiting for you${waiting.count > 1 ? ` · ${waiting.count}` : ""}`, size: 26, color: "#ffc658" }
          : { text: sub, size: 26, color: "#c8d0da", weight: 500 },
      ],
      { width: 512, height: 128, background: "rgba(16,20,28,0.72)", radius: 40 },
    );
  }, [close, agent.name, agent.project, agent.harness, waiting?.count]);
  useEffect(() => () => tag.dispose(), [tag]);

  const card = useMemo(
    () => (waiting ? textTexture([{ text: CARD[waiting.type].glyph, size: 150, color: "#ffffff", weight: 800 }], { width: 256, height: 256, background: CARD[waiting.type].color, radius: 28 }) : null),
    [waiting?.type],
  );
  useEffect(() => () => card?.dispose(), [card]);

  // The bubble is as wide as what is said, up to a limit.
  const saidWidth = bubble ? Math.min(1024, 120 + bubble.length * 15) : 0;
  const said = useMemo(
    () => (bubble ? textTexture([{ text: bubble, size: 30, color: "#16202c", weight: 600 }], { width: saidWidth, height: 96, background: "rgba(255,255,255,0.94)", radius: 44 }) : null),
    [bubble],
  );
  useEffect(() => () => said?.dispose(), [said]);

  useFrame((state, dt) => {
    const m = motion.current;
    const g = root.current;
    if (!g) return;
    const step = Math.min(dt, 0.1);
    let walking = false;
    let remaining = WALK_SPEED * step;
    while (remaining > 0 && m.path.length) {
      const [tx, tz] = m.path[0]!;
      const dx = tx - m.pos[0];
      const dz = tz - m.pos[1];
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        m.path.shift();
        continue;
      }
      walking = true;
      const move = Math.min(d, remaining);
      m.pos[0] += (dx / d) * move;
      m.pos[1] += (dz / d) * move;
      remaining -= move;
      m.yaw = turn(m.yaw, Math.atan2(dx, dz), TURN_RATE * step);
      if (move >= d) m.path.shift();
    }
    if (!walking) m.yaw = turn(m.yaw, m.spot.facing, TURN_RATE * 0.5 * step);
    g.position.set(m.pos[0], 0, m.pos[1]);
    g.rotation.y = m.yaw;

    const t = state.clock.elapsedTime + m.phase;
    const typing = !walking && m.spot.zone === "team" && agent.status === "working";
    const holding = m.spot.zone === "queue" || carrying;
    if (speech.current) speech.current.visible = !walking;
    const swing = walking ? Math.sin(t * 9) * 0.55 : 0;
    const [ll, lr] = legs.current;
    const [al, ar] = arms.current;
    if (ll && lr) {
      ll.rotation.x = swing;
      lr.rotation.x = -swing;
    }
    if (al && ar) {
      if (typing) {
        al.rotation.x = -1.15 + Math.sin(t * 14) * 0.08;
        ar.rotation.x = -1.15 + Math.sin(t * 14 + 1.7) * 0.08;
      } else {
        al.rotation.x = walking ? -swing * 0.8 : Math.sin(t * 1.3) * 0.04;
        ar.rotation.x = holding ? -0.9 : walking ? swing * 0.8 : Math.sin(t * 1.3 + 1) * 0.04;
      }
    }
    // Walking bob, and a gentle breath at rest.
    g.position.y = walking ? Math.abs(Math.sin(t * 9)) * 0.035 : Math.sin(t * 1.6) * 0.006;

    const status = LAMP[agent.status];
    const pulse = agent.status === "working" ? 0.75 + 0.25 * Math.sin(t * 4) : agent.status === "blocked" ? (Math.sin(t * 6) > 0 ? 1 : 0.35) : 1;
    if (lamp.current) {
      lamp.current.position.y = 2.18 + Math.sin(t * 2) * 0.03;
      (lamp.current.material as MeshBasicMaterial).opacity = 0.35 + 0.65 * status.glow * pulse;
    }
    if (halo.current) {
      halo.current.position.y = lamp.current?.position.y ?? 2.18;
      const s = 1 + 0.25 * pulse * status.glow;
      halo.current.scale.setScalar(s);
      (halo.current.material as MeshBasicMaterial).opacity = 0.28 * status.glow * pulse;
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta < 6) onSelect(agent.id);
  };

  return (
    <group
      ref={root}
      onClick={click}
      onPointerOver={(e) => (e.stopPropagation(), setHovered(true))}
      onPointerOut={() => setHovered(false)}
    >
      <group scale={look.height}>
        <Body look={look} legs={legs} arms={arms} card={card} folder={carrying} />
      </group>
      <mesh ref={lamp} position={[0, 2.18, 0]}>
        <sphereGeometry args={[0.08, 20, 16]} />
        <meshBasicMaterial color={LAMP[agent.status].color} transparent toneMapped={false} />
      </mesh>
      <mesh ref={halo} position={[0, 2.18, 0]}>
        <sphereGeometry args={[0.2, 20, 16]} />
        <meshBasicMaterial color={LAMP[agent.status].color} transparent opacity={0.2} depthWrite={false} toneMapped={false} />
      </mesh>
      <sprite position={close ? [0, 2.42, 0] : [0, 2.68, 0]} scale={close ? [0.56, 0.14, 1] : [1.5, 0.375, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
      {said ? (
        <group ref={speech} position={[0, 3.12, 0]}>
          <sprite scale={[(saidWidth / 96) * 0.36, 0.36, 1]}>
            <spriteMaterial map={said} transparent depthWrite={false} />
          </sprite>
        </group>
      ) : null}
      {selected || hovered ? (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]}>
          <ringGeometry args={[0.42, 0.52, 40]} />
          <meshBasicMaterial color={selected ? "#5b9dff" : "#ffffff"} transparent opacity={selected ? 0.9 : 0.5} toneMapped={false} />
        </mesh>
      ) : null}
    </group>
  );
}

function turn(from: number, to: number, max: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + Math.max(-max, Math.min(max, d));
}

export function Body({ look, legs, arms, card, folder = false }: {
  look: Look;
  legs: RefObject<[Group | null, Group | null]>;
  arms: RefObject<[Group | null, Group | null]>;
  card: Texture | null;
  folder?: boolean;
}) {
  const skin = <meshStandardMaterial color={look.skin} roughness={0.7} />;
  const shirt = <meshStandardMaterial color={look.shirt} roughness={0.8} />;
  const pants = <meshStandardMaterial color={look.pants} roughness={0.85} />;
  return (
    <group>
      {([-1, 1] as const).map((side, i) => (
        <group key={side} ref={(g) => void (legs.current[i] = g)} position={[side * 0.1, 0.86, 0]}>
          <mesh position={[0, -0.4, 0]} castShadow>
            <capsuleGeometry args={[0.085, 0.62, 4, 12]} />
            {pants}
          </mesh>
          <mesh position={[0, -0.82, 0.05]} castShadow>
            <boxGeometry args={[0.15, 0.08, 0.28]} />
            <meshStandardMaterial color={look.shoes} roughness={0.6} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 1.16, 0]} scale={[look.build, 1, 0.72]} castShadow>
        <capsuleGeometry args={[0.2, 0.34, 6, 16]} />
        {shirt}
      </mesh>
      {/* A small badge in the agent's accent colour. */}
      <mesh position={[0.1 * look.build, 1.3, 0.15]}>
        <circleGeometry args={[0.035, 16]} />
        <meshStandardMaterial color={look.accent} emissive={look.accent} emissiveIntensity={0.25} />
      </mesh>
      {([-1, 1] as const).map((side, i) => (
        <group key={side} ref={(g) => void (arms.current[i] = g)} position={[side * 0.27 * look.build, 1.42, 0]}>
          <mesh position={[0, -0.27, 0]} castShadow>
            <capsuleGeometry args={[0.058, 0.42, 4, 10]} />
            {shirt}
          </mesh>
          <mesh position={[0, -0.54, 0]}>
            <sphereGeometry args={[0.066, 12, 10]} />
            {skin}
          </mesh>
          {side === 1 && folder ? (
            <mesh position={[0, -0.6, 0.14]} rotation={[Math.PI / 2 - 0.9, 0, 0]} castShadow>
              <boxGeometry args={[0.3, 0.38, 0.04]} />
              <meshStandardMaterial color="#e3b95f" roughness={0.8} />
            </mesh>
          ) : side === 1 && card ? (
            <mesh position={[0, -0.6, 0.12]} rotation={[Math.PI / 2 - 0.9, 0, 0]}>
              <planeGeometry args={[0.26, 0.26]} />
              <meshBasicMaterial map={card} toneMapped={false} side={2} />
            </mesh>
          ) : null}
        </group>
      ))}
      <mesh position={[0, 1.55, 0]}>
        <cylinderGeometry args={[0.06, 0.07, 0.1, 12]} />
        {skin}
      </mesh>
      <group position={[0, 1.73, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.165, 24, 20]} />
          {skin}
        </mesh>
        {([-1, 1] as const).map((side) => (
          <mesh key={side} position={[side * 0.058, 0.02, 0.152]}>
            <sphereGeometry args={[0.02, 10, 8]} />
            <meshStandardMaterial color="#15171b" roughness={0.3} />
          </mesh>
        ))}
        <mesh position={[0, -0.06, 0.155]} rotation={[0, 0, Math.PI]}>
          <torusGeometry args={[0.035, 0.008, 6, 12, Math.PI]} />
          <meshStandardMaterial color="#6d3b33" />
        </mesh>
        <Hair look={look} />
        <Accessory look={look} />
      </group>
    </group>
  );
}

function Hair({ look }: { look: Look }) {
  const mat = <meshStandardMaterial color={look.hair} roughness={0.9} />;
  const cap = (
    <mesh position={[0, 0.03, -0.01]} rotation-x={-0.45} scale={[1.06, 1, 1.08]}>
      <sphereGeometry args={[0.17, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
      {mat}
    </mesh>
  );
  switch (look.hairStyle) {
    case "bald":
      return null;
    case "short":
      return cap;
    case "long":
      return (
        <group>
          {cap}
          <mesh position={[0, -0.1, -0.08]}>
            <boxGeometry args={[0.34, 0.34, 0.16]} />
            {mat}
          </mesh>
        </group>
      );
    case "bob":
      return (
        <group>
          {cap}
          <mesh position={[0, -0.03, -0.02]} scale={[1.12, 0.8, 1.1]}>
            <sphereGeometry args={[0.17, 20, 14, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.35]} />
            <meshStandardMaterial color={look.hair} roughness={0.9} side={2} />
          </mesh>
        </group>
      );
    case "bun":
      return (
        <group>
          {cap}
          <mesh position={[0, 0.17, -0.1]}>
            <sphereGeometry args={[0.075, 16, 12]} />
            {mat}
          </mesh>
        </group>
      );
    case "spiky":
      return (
        <group>
          {cap}
          {[-0.08, 0, 0.08].flatMap((x) => [-0.05, 0.05].map((z) => (
            <mesh key={`${x}${z}`} position={[x, 0.18, z]} rotation={[z * 3, 0, -x * 3]}>
              <coneGeometry args={[0.04, 0.12, 6]} />
              {mat}
            </mesh>
          )))}
        </group>
      );
    case "curly":
      return (
        <group>
          {Array.from({ length: 11 }, (_, i) => {
            const a = (i / 11) * Math.PI * 2;
            return (
              <mesh key={i} position={[Math.sin(a) * 0.12, 0.1 + (i % 2) * 0.04, Math.cos(a) * 0.12 - 0.02]}>
                <sphereGeometry args={[0.065, 10, 8]} />
                {mat}
              </mesh>
            );
          })}
          <mesh position={[0, 0.15, -0.01]}>
            <sphereGeometry args={[0.09, 12, 10]} />
            {mat}
          </mesh>
        </group>
      );
    case "mohawk":
      return (
        <mesh position={[0, 0.17, -0.01]}>
          <boxGeometry args={[0.05, 0.1, 0.3]} />
          {mat}
        </mesh>
      );
  }
}

function Accessory({ look }: { look: Look }) {
  switch (look.accessory) {
    case "glasses":
      return (
        <group position={[0, 0.02, 0.16]}>
          {([-1, 1] as const).map((side) => (
            <mesh key={side} position={[side * 0.058, 0, 0]}>
              <torusGeometry args={[0.035, 0.007, 6, 16]} />
              <meshStandardMaterial color="#1c1c1c" />
            </mesh>
          ))}
          <mesh>
            <boxGeometry args={[0.05, 0.008, 0.008]} />
            <meshStandardMaterial color="#1c1c1c" />
          </mesh>
        </group>
      );
    case "headphones":
      return (
        <group>
          <mesh rotation={[0, Math.PI / 2, 0]} position={[0, 0.02, 0]}>
            <torusGeometry args={[0.18, 0.018, 8, 24, Math.PI]} />
            <meshStandardMaterial color="#22252b" />
          </mesh>
          {([-1, 1] as const).map((side) => (
            <mesh key={side} position={[side * 0.17, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.06, 0.06, 0.05, 16]} />
              <meshStandardMaterial color={look.accent} />
            </mesh>
          ))}
        </group>
      );
    case "cap":
      return (
        <group position={[0, 0.07, 0]}>
          <mesh>
            <sphereGeometry args={[0.178, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
            <meshStandardMaterial color={look.accent} roughness={0.8} />
          </mesh>
          <mesh position={[0, 0, 0.16]} rotation={[-0.15, 0, 0]}>
            <cylinderGeometry args={[0.1, 0.1, 0.015, 20, 1, false, -Math.PI / 2, Math.PI]} />
            <meshStandardMaterial color={look.accent} roughness={0.8} />
          </mesh>
        </group>
      );
    case "beanie":
      return (
        <mesh position={[0, 0.06, 0]} rotation-x={-0.3} scale={[1.1, 1.05, 1.1]}>
          <sphereGeometry args={[0.17, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <meshStandardMaterial color={look.accent} roughness={0.95} />
        </mesh>
      );
    case "none":
      return null;
  }
}

