import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { CircleGeometry, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, RingGeometry, type Mesh } from "three";
import type { UsageMeter } from "../../shared/types.ts";
import type { Garden } from "./building.ts";
import { textTexture } from "./label.ts";
import { meterLook, meterSpots, RING_OUT, TONES, type MeterSpot } from "./meters.ts";
import { usePace } from "./Pace.tsx";

// The usage meters as water towers on the east lawn (meters.ts says where and what each shows):
// a glass tank on a stone foot under a wooden roof, the water in it at the share used, a ring
// round its foot counting down to the reset. A handful of shared shapes; nothing moves but when
// a level changes, while you hover over one, or where one runs over.

const UNIT = new CylinderGeometry(1, 1, 1, 20);
const ROOF = new ConeGeometry(1, 1, 20);
const DROP = new IcosahedronGeometry(1, 0);
const PUDDLE = new CircleGeometry(1, 20);
const TRACK = new RingGeometry(1.22, RING_OUT, 40);
/** The stone foot's height, and the water's radius: just over the glass's, so the glass shows only above the water. */
const FOOT = 0.1;
const INSIDE = 1.004;
const FADED = new Color("#b9bdb6");
const DRIPS = 3;

/** The meters' towers in the garden, the ring round each counting down a minute at a time. */
export function Meters({ garden, meters }: { garden: Garden; meters: UsageMeter[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const spots = useMemo(() => meterSpots(garden, meters), [garden, meters]);
  return (
    <group>
      {spots.map((s) => <Tower key={s.id} spot={s} meter={meters.find((m) => m.id === s.id)!} now={now} />)}
    </group>
  );
}

function Tower({ spot, meter, now }: { spot: MeterSpot; meter: UsageMeter; now: number }) {
  const pace = usePace();
  const look = meterLook(meter, now);
  const { radius: r, height: h } = spot;
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const water = useRef<Mesh>(null);
  const drips = useRef<Array<Mesh | null>>([]);
  const shown = useRef(look.level);
  const sloshFrom = useRef(-Infinity);

  const color = useMemo(() => {
    const c = new Color(TONES[look.tone]);
    return `#${(look.faded ? c.lerp(FADED, 0.6) : c).getHexString()}`;
  }, [look.tone, look.faded]);
  // The countdown: what is left of the window, a full ring just after a reset, from the north round.
  const left = look.left === null ? 0 : Math.round(look.left * 240) / 240;
  const countdown = useMemo(() => (left > 0 ? new RingGeometry(1.22, RING_OUT, Math.max(3, Math.ceil(left * 40)), 1, Math.PI / 2, left * Math.PI * 2) : null), [left]);
  useEffect(() => () => countdown?.dispose(), [countdown]);
  const tagWidth = Math.min(1100, 70 + look.label.length * 18);
  const tag = useMemo(
    () => textTexture([{ text: look.label, size: 36, color: "#ffffff", weight: 600 }], { width: tagWidth, height: 68, background: "rgba(16,20,28,0.72)", radius: 32 }),
    [look.label, tagWidth],
  );
  useEffect(() => () => tag.dispose(), [tag]);

  useFrame((state, delta) => {
    const t = performance.now();
    const mesh = water.current;
    if (mesh) {
      // A changed level runs up or down to its new mark, drawing at full rate until it is there.
      const target = look.level;
      if (Math.abs(shown.current - target) > 0.002) {
        shown.current += (target - shown.current) * Math.min(1, delta * 2.5);
        pace?.moved(t);
      } else shown.current = target;
      const level = Math.max(shown.current, 0.001);
      mesh.scale.set(r * INSIDE, h * level, r * INSIDE);
      mesh.position.y = FOOT + (h * level) / 2;
      // Hovering sets the water rocking a moment.
      const since = (t - sloshFrom.current) / 1000;
      const slosh = since < 1.6 ? Math.sin(since * 9) * 0.045 * (1 - since / 1.6) : 0;
      mesh.rotation.set(slosh, 0, slosh * 0.6);
      if (slosh) pace?.moved(t);
    }
    if (look.over) {
      // Drops running down the side towards you and falling into the puddle, at whatever rate the office is drawn.
      const s = state.clock.elapsedTime;
      drips.current.forEach((d, i) => {
        if (!d) return;
        const f = (s / 1.5 + i / DRIPS) % 1;
        const a = (i - 1) * 0.5;
        const out = r * (1.04 + f * 0.12);
        d.position.set(Math.sin(a) * out, FOOT + h * (1 - f), Math.cos(a) * out);
        d.scale.setScalar(0.035 + 0.01 * Math.sin(f * Math.PI));
      });
    }
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!hovered) sloshFrom.current = performance.now();
    setHovered(true);
    pace?.moved(performance.now());
  };
  const out = () => {
    setHovered(false);
    pace?.moved(performance.now());
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta < 6) setPinned((p) => !p), pace?.moved(performance.now());
  };

  return (
    <group position={[spot.pos[0], 0, spot.pos[1]]}>
      <group onPointerOver={over} onPointerOut={out} onClick={click}>
        <mesh geometry={UNIT} position={[0, FOOT / 2, 0]} scale={[r * 1.12, FOOT, r * 1.12]} castShadow receiveShadow>
          <meshStandardMaterial color="#c9c0ae" roughness={0.95} />
        </mesh>
        <mesh ref={water} geometry={UNIT} position={[0, FOOT, 0]}>
          <meshStandardMaterial color={color} roughness={0.25} />
        </mesh>
        <mesh geometry={UNIT} position={[0, FOOT + h / 2, 0]} scale={[r, h, r]} castShadow>
          <meshStandardMaterial color="#b4d4e4" transparent opacity={look.faded ? 0.5 : 0.4} roughness={0.08} depthWrite={false} />
        </mesh>
        {[0.04, 0.5, 0.97].map((k) => (
          <mesh key={k} geometry={UNIT} position={[0, FOOT + h * k, 0]} scale={[r * 1.025, 0.045, r * 1.025]}>
            <meshStandardMaterial color="#5b4636" roughness={0.8} />
          </mesh>
        ))}
        <mesh geometry={ROOF} position={[0, FOOT + h + r * 0.32, 0]} scale={[r * 1.18, r * 0.64, r * 1.18]} castShadow>
          <meshStandardMaterial color={look.faded ? "#a1907f" : "#8a5a3c"} roughness={0.9} />
        </mesh>
      </group>
      <mesh geometry={TRACK} position={[0, 0.012, 0]} rotation-x={-Math.PI / 2} scale={r}>
        <meshBasicMaterial color="#2f3a2a" transparent opacity={0.28} depthWrite={false} />
      </mesh>
      {countdown ? (
        <mesh geometry={countdown} position={[0, 0.014, 0]} rotation-x={-Math.PI / 2} scale={r}>
          <meshBasicMaterial color="#f4efe2" transparent opacity={look.faded ? 0.45 : 0.9} depthWrite={false} />
        </mesh>
      ) : null}
      {look.over ? (
        <group>
          <mesh geometry={PUDDLE} position={[0, 0.011, r * 0.4]} rotation-x={-Math.PI / 2} scale={[r * 1.5, r * 1.1, 1]}>
            <meshStandardMaterial color={color} transparent opacity={0.65} roughness={0.15} depthWrite={false} />
          </mesh>
          {Array.from({ length: DRIPS }, (_, i) => (
            <mesh key={i} ref={(d) => void (drips.current[i] = d)} geometry={DROP}>
              <meshStandardMaterial color={color} roughness={0.15} />
            </mesh>
          ))}
        </group>
      ) : null}
      {hovered || pinned ? (
        <sprite position={[0, FOOT + h + r * 0.64 + 0.32, 0]} scale={[(tagWidth / 68) * 0.2, 0.2, 1]}>
          <spriteMaterial map={tag} transparent depthWrite={false} depthTest={false} fog={false} />
        </sprite>
      ) : null}
    </group>
  );
}
