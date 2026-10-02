import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { CanvasTexture, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, InstancedBufferAttribute, Object3D, RepeatWrapping, RingGeometry, SRGBColorSpace, type InstancedMesh, type Mesh } from "three";
import type { UsageMeter } from "../../shared/types.ts";
import type { Garden } from "./building.ts";
import { textTexture } from "./label.ts";
import { fallenSeeds, meterLook, meterSpots, perches, RING_OUT, TONES, TRAY, TRAY_THICK, type MeterLook, type MeterSpot, type Perch } from "./meters.ts";
import { usePace } from "./Pace.tsx";

// The usage meters as bird feeders on the east lawn (meters.ts says where and what each shows):
// a glass of seed on a wooden post under a little roof, the seed at what is left of the limit, a
// band round the post in its tone, a ring on the ground counting down to the reset. A handful of
// shared shapes; the birds are two instanced draws for every feeder together, and they only hop
// and peck at whatever rate the office is drawn, so they never keep it busy.

const UNIT = new CylinderGeometry(1, 1, 1, 14);
const POST = new CylinderGeometry(1, 1, 1, 6);
const ROOF = new ConeGeometry(1, 1, 8);
const PEBBLE = new IcosahedronGeometry(1, 0);
const BEAK = new ConeGeometry(1, 1, 4).rotateX(Math.PI / 2);
const TRACK = new RingGeometry(1.22, RING_OUT, 40);
const FADED = new Color("#b9bdb6");
const WOOD = "#7a5a3c";
/** The seed, as it is: a mix of millet, sunflower and wheat. */
const SEED = "#c9a66b";
const SEEDS = ["#d9bd84", "#b48a52", "#3b3430", "#e2cf9e", "#9c7444"];

/** A speckle of seeds to lay over the glass's fill, so it reads as seed and not paint. Made once, when first needed. */
let grain: CanvasTexture | null = null;
function seedGrain(): CanvasTexture {
  if (grain) return grain;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d")!;
  g.fillStyle = SEED;
  g.fillRect(0, 0, 64, 64);
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = SEEDS[i % SEEDS.length]!;
    g.beginPath();
    g.ellipse(rand() * 64, rand() * 64, 1 + rand() * 1.6, 0.7 + rand() * 0.8, rand() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  grain = new CanvasTexture(canvas);
  grain.wrapS = grain.wrapT = RepeatWrapping;
  grain.repeat.set(2, 1);
  grain.colorSpace = SRGBColorSpace;
  return grain;
}

/** Colours an instanced mesh, into its colours already on the GPU when it has them: a new attribute on a mesh already drawn shows black. */
function paint(mesh: InstancedMesh, colors: Float32Array) {
  if (mesh.instanceColor && mesh.instanceColor.array.length === colors.length) {
    mesh.instanceColor.array.set(colors);
    mesh.instanceColor.needsUpdate = true;
  } else mesh.instanceColor = new InstancedBufferAttribute(colors, 3);
}

const fade = (hex: string, faded: boolean, by = 0.6) => {
  const c = new Color(hex);
  return `#${(faded ? c.lerp(FADED, by) : c).getHexString()}`;
};

/** The meters' feeders in the garden, the birds at them, and the ring round each counting down a minute at a time. */
export function Meters({ garden, meters }: { garden: Garden; meters: UsageMeter[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Where the feeders stand changes only with which meters there are, not with every new reading.
  const kinds = meters.map((m) => `${m.id}:${m.window}`).join(",");
  const spots = useMemo(() => meterSpots(garden, meters), [garden, kinds]);
  const looks = spots.map((s) => meterLook(meters.find((m) => m.id === s.id)!, now));
  const birdKey = spots.map((s, i) => `${s.id}:${looks[i]!.birds}`).join(",");
  const birds = useMemo(() => spots.flatMap((s, i) => perches(s, looks[i]!.birds)), [spots, birdKey]);
  const emptyKey = spots.map((s, i) => (looks[i]!.empty ? s.id : "")).join(",");
  const fallen = useMemo(() => spots.flatMap((s, i) => (looks[i]!.empty ? fallenSeeds(s) : [])), [spots, emptyKey]);
  return (
    <group>
      {spots.map((s, i) => <Feeder key={s.id} spot={s} look={looks[i]!} />)}
      <Rods key={spots.length} spots={spots} faded={looks.map((l) => l.faded).join(",")} />
      {birds.length ? <Birds key={birds.length} perches={birds} /> : null}
      {fallen.length ? <Fallen key={fallen.length} seeds={fallen} /> : null}
    </group>
  );
}

function Feeder({ spot, look }: { spot: MeterSpot; look: MeterLook }) {
  const pace = usePace();
  const { glass: r, height: h, post } = spot;
  const base = post + TRAY_THICK;
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const fill = useRef<Mesh>(null);
  const shown = useRef(look.seed);

  const band = useMemo(() => fade(TONES[look.tone], look.faded), [look.tone, look.faded]);
  const seed = look.faded ? fade(SEED, true, 0.35) : "#ffffff";
  const wood = fade(WOOD, look.faded, 0.4);
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

  useFrame((_, delta) => {
    const mesh = fill.current;
    if (!mesh) return;
    // A changed level runs up or down to its new mark, drawing at full rate until it is there.
    const target = look.seed;
    if (Math.abs(shown.current - target) > 0.002) {
      shown.current += (target - shown.current) * Math.min(1, delta * 2.5);
      pace?.moved(performance.now());
    } else shown.current = target;
    const level = Math.max(shown.current, 0.001);
    mesh.visible = shown.current > 0.004;
    mesh.scale.set(r * 0.94, h * level, r * 0.94);
    mesh.position.y = base + (h * level) / 2;
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
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
        <mesh geometry={POST} position={[0, post / 2, 0]} scale={[0.04, post, 0.04]} castShadow>
          <meshStandardMaterial color={wood} roughness={0.95} flatShading />
        </mesh>
        <mesh geometry={POST} position={[0, post * 0.55, 0]} scale={[0.052, 0.08, 0.052]}>
          <meshStandardMaterial color={band} roughness={0.5} flatShading />
        </mesh>
        <mesh geometry={UNIT} position={[0, post + TRAY_THICK / 2, 0]} scale={[r * TRAY, TRAY_THICK, r * TRAY]} castShadow receiveShadow>
          <meshStandardMaterial color={wood} roughness={0.9} />
        </mesh>
        {look.seed > 0 ? (
          <mesh geometry={UNIT} position={[0, base + 0.006, 0]} scale={[r * TRAY * 0.86, 0.012, r * TRAY * 0.86]}>
            <meshStandardMaterial map={seedGrain()} color={seed} roughness={1} />
          </mesh>
        ) : null}
        <mesh ref={fill} geometry={UNIT} position={[0, base, 0]}>
          <meshStandardMaterial map={seedGrain()} color={seed} roughness={1} />
        </mesh>
        <mesh geometry={UNIT} position={[0, base + h / 2, 0]} scale={[r, h, r]}>
          <meshStandardMaterial color="#d6e8ee" transparent opacity={look.faded ? 0.45 : 0.36} roughness={0.08} depthWrite={false} />
        </mesh>
        <mesh geometry={UNIT} position={[0, base + h + 0.012, 0]} scale={[r * 1.08, 0.024, r * 1.08]}>
          <meshStandardMaterial color={wood} roughness={0.9} />
        </mesh>
        <mesh geometry={ROOF} position={[0, base + h + 0.024 + r * 0.42, 0]} scale={[r * 1.75, r * 0.84, r * 1.75]} rotation-y={Math.PI / 8} castShadow>
          <meshStandardMaterial color={fade("#8a4f34", look.faded, 0.4)} roughness={0.9} flatShading />
        </mesh>
      </group>
      <mesh geometry={TRACK} position={[0, 0.012, 0]} rotation-x={-Math.PI / 2} scale={spot.radius}>
        <meshBasicMaterial color="#2f3a2a" transparent opacity={0.28} depthWrite={false} />
      </mesh>
      {countdown ? (
        <mesh geometry={countdown} position={[0, 0.014, 0]} rotation-x={-Math.PI / 2} scale={spot.radius}>
          <meshBasicMaterial color="#f4efe2" transparent opacity={look.faded ? 0.45 : 0.9} depthWrite={false} />
        </mesh>
      ) : null}
      {hovered || pinned ? (
        <sprite position={[0, base + h + r * 0.84 + 0.3, 0]} scale={[(tagWidth / 68) * 0.2, 0.2, 1]}>
          <spriteMaterial map={tag} transparent depthWrite={false} depthTest={false} fog={false} />
        </sprite>
      ) : null}
    </group>
  );
}

/** A sparrow, a blue tit and a robin: body, head, tail and beak. */
const KINDS = [
  ["#8a6a4a", "#6b5a4a", "#5a4632", "#3a3330"],
  ["#e0c454", "#3f6fb0", "#4a6f9a", "#2f2e33"],
  ["#c4612f", "#7a5b41", "#6b5038", "#3a3330"],
];
const BIRD = 1.35;

/**
 * The birds at the feeders: those on the tray turn and peck at the seed; those on the ground peck,
 * and now and then hop a little way round the post. Nothing here asks the office to draw faster.
 */
function Birds({ perches }: { perches: Perch[] }) {
  const parts = useRef<InstancedMesh>(null);
  const beaks = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const tint = (pick: (k: string[]) => string[]) => {
      const list = perches.flatMap((_, i) => pick(KINDS[i % KINDS.length]!));
      const out = new Float32Array(list.length * 3);
      const c = new Color();
      list.forEach((hex, i) => c.set(hex).toArray(out, i * 3));
      return out;
    };
    paint(parts.current!, tint((k) => k.slice(0, 3)));
    paint(beaks.current!, tint((k) => [k[3]!]));
  }, [perches]);

  const { root, part } = useMemo(() => {
    const root = new Object3D();
    const part = new Object3D();
    root.add(part);
    return { root, part };
  }, []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const body = parts.current;
    const beak = beaks.current;
    if (!body || !beak) return;
    const put = (mesh: InstancedMesh, i: number, at: [number, number, number], size: [number, number, number], pitch = 0) => {
      part.position.set(...at);
      part.rotation.set(pitch, 0, 0);
      part.scale.set(...size);
      part.updateMatrixWorld(true);
      mesh.setMatrixAt(i, part.matrixWorld);
    };
    perches.forEach((p, i) => {
      // Two quick pecks every couple of seconds, each bird out of step with the next.
      const cycle = (t / (2.1 + i * 0.37) + i * 0.31) % 1;
      const peck = cycle < 0.24 ? Math.abs(Math.sin((cycle / 0.24) * Math.PI * 2)) : 0;
      let [x, z] = p.pos;
      let y = p.y;
      let yaw = p.yaw;
      if (p.on === "ground") {
        // Every few seconds a short hop to a new spot a little way round the post, there and back.
        const s = t / 3.6 + i * 0.5;
        const step = Math.floor(s);
        const hop = Math.min(1, (s - step) / 0.14);
        const off = (k: number) => 0.3 * Math.sin(k * 2.1 + i);
        const turn = off(step) + (off(step + 1) - off(step)) * hop;
        const [dx, dz] = [p.pos[0] - p.post[0], p.pos[1] - p.post[1]];
        const [sin, cos] = [Math.sin(turn), Math.cos(turn)];
        x = p.post[0] + dx * cos + dz * sin;
        z = p.post[1] - dx * sin + dz * cos;
        y += Math.sin(hop * Math.PI) * 0.05;
        // Hopping back the other way, it faces the way it goes.
        yaw += turn + (off(step + 1) < off(step) && hop < 1 ? Math.PI : 0);
      } else {
        // On the tray it shuffles round a little, now one way, now the other.
        yaw += 0.35 * Math.sin(Math.floor(t / 2.7 + i) * 1.7);
      }
      root.position.set(x, y, z);
      root.rotation.set(peck * (p.on === "ground" ? 0.75 : 0.5), yaw, 0, "YXZ");
      root.scale.setScalar(BIRD);
      root.updateMatrixWorld(true);
      put(body, i * 3, [0, 0.045, 0], [0.042, 0.038, 0.066]);
      put(body, i * 3 + 1, [0, 0.085, 0.045], [0.031, 0.031, 0.031]);
      put(body, i * 3 + 2, [0, 0.055, -0.07], [0.024, 0.008, 0.045], 0.35);
      put(beak, i, [0, 0.082, 0.083], [0.01, 0.01, 0.024]);
    });
    body.instanceMatrix.needsUpdate = true;
    beak.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={parts} args={[PEBBLE, undefined, perches.length * 3]} castShadow frustumCulled={false}>
        <meshStandardMaterial roughness={0.75} flatShading />
      </instancedMesh>
      <instancedMesh ref={beaks} args={[BEAK, undefined, perches.length]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.6} flatShading />
      </instancedMesh>
    </group>
  );
}

/** Three thin wooden rods round each feeder's glass, from the tray to the lid, so an empty glass still reads as one: one draw for every feeder. */
function Rods({ spots, faded }: { spots: MeterSpot[]; faded: string }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new Object3D();
    const dim = faded.split(",");
    const colors = new Float32Array(spots.length * 3 * 3);
    const c = new Color();
    spots.forEach((s, i) => {
      c.set(fade(WOOD, dim[i] === "true", 0.4));
      for (let k = 0; k < 3; k++) {
        const a = Math.PI / 3 + (k * Math.PI * 2) / 3;
        o.position.set(s.pos[0] + Math.sin(a) * s.glass * 1.03, s.post + TRAY_THICK + s.height / 2, s.pos[1] + Math.cos(a) * s.glass * 1.03);
        o.scale.set(0.012, s.height, 0.012);
        o.updateMatrix();
        mesh.setMatrixAt(i * 3 + k, o.matrix);
        c.toArray(colors, (i * 3 + k) * 3);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    paint(mesh, colors);
  }, [spots, faded]);
  if (!spots.length) return null;
  return (
    <instancedMesh ref={ref} args={[POST, undefined, spots.length * 3]} frustumCulled={false}>
      <meshStandardMaterial roughness={0.9} flatShading />
    </instancedMesh>
  );
}

/** The few seeds lying under an empty feeder. */
function Fallen({ seeds }: { seeds: Array<[number, number]> }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current!;
    const o = new Object3D();
    const colors = new Float32Array(seeds.length * 3);
    const c = new Color();
    seeds.forEach(([x, z], i) => {
      o.position.set(x, 0.014, z);
      o.rotation.set(0, i * 1.9, 0);
      o.scale.set(0.03, 0.012, 0.019);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      c.set(SEEDS[i % SEEDS.length]!).toArray(colors, i * 3);
    });
    mesh.instanceMatrix.needsUpdate = true;
    paint(mesh, colors);
  }, [seeds]);
  return (
    <instancedMesh ref={ref} args={[PEBBLE, undefined, seeds.length]} frustumCulled={false}>
      <meshStandardMaterial roughness={0.9} flatShading />
    </instancedMesh>
  );
}
