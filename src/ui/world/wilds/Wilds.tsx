import { addAfterEffect, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedMesh, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry } from "three";
import type { Rect } from "../building.ts";
import { ANIMAL_RADIUS, MAX_ANIMALS, populate, stepAnimals, type Animal, type Species } from "./animals.ts";
import { CHUNK, GRID, MAX_CHUNKS, Stream, WATER, type Chunk, type Kind } from "./land.ts";
import { animalMaterial, creature, scenery } from "./shapes.tsx";
import { gaitPose } from "./gait.ts";

const KINDS: Kind[] = ["pine", "oak", "rock", "grass", "shore"];
const SPECIES: Species[] = ["deer", "rabbit", "duck", "bird"];
interface Drawing {
  root: Group;
  stream: Stream;
  slots: Map<string, Mesh>;
  free: Mesh[];
  plants: Map<string, InstancedMesh>;
  life: Map<Species, InstancedMesh>;
  water: InstancedMesh;
  dirty: boolean;
  animals: Animal[];
  animalX: number;
  animalZ: number;
  animalElapsed: number;
  lastView: number[];
  pump: () => void;
}

/** Fixed GPU pools; one worker request in flight; all terrain slots reused, never accumulated. */
export function Wilds({ office }: { office: Rect }) {
  const { scene, camera, gl } = useThree();
  const drawing = useRef<Drawing | null>(null);
  const matrix = useRef(new Object3D());
  const frameStart = useRef(0);
  const work = useRef({ rebuildMs: 0, installMs: 0, swaps: 0 });
  const size = JSON.stringify(office);
  useEffect(() => {
    const root = new Group();
    root.name = "Wilds — bounded landscape";
    scene.add(root);
    const geometries: BufferGeometry[] = [];
    const material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
    const waterMaterial = new MeshStandardMaterial({ color: "#659da7", roughness: 1 });
    const free: Mesh[] = [];
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(GRID * GRID * 18), 3));
      g.setAttribute("color", new BufferAttribute(new Float32Array(GRID * GRID * 18), 3));
      const mesh = new Mesh(g, material);
      mesh.visible = false;
      root.add(mesh); free.push(mesh); geometries.push(g);
    }
    const plants = new Map<string, InstancedMesh>();
    for (const lod of [0, 1] as const) for (const kind of KINDS) {
      if (lod === 1 && (kind === "grass" || kind === "shore")) continue;
      const g = scenery(kind, lod);
      // Only nine near / sixteen mid chunks. A generous fixed capacity per batch.
      const mesh = new InstancedMesh(g, material, (lod === 0 ? 9 : 16) * 80);
      mesh.count = 0; mesh.frustumCulled = false;
      plants.set(`${lod}:${kind}`, mesh); root.add(mesh); geometries.push(g);
    }
    const life = new Map<Species, InstancedMesh>();
    const lifeMaterial = animalMaterial();
    for (const kind of SPECIES) {
      const g = creature(kind);
      g.setAttribute('instanceGait', new InstancedBufferAttribute(new Float32Array(MAX_ANIMALS * 2), 2));
      const mesh = new InstancedMesh(g, lifeMaterial, MAX_ANIMALS);
      mesh.count = 0; mesh.frustumCulled = false;
      life.set(kind, mesh); root.add(mesh); geometries.push(g);
    }
    const waterGeometry = new PlaneGeometry(CHUNK, CHUNK).rotateX(-Math.PI / 2);
    const water = new InstancedMesh(waterGeometry, waterMaterial, MAX_CHUNKS);
    water.count = 0; water.frustumCulled = false;
    root.add(water); geometries.push(waterGeometry);
    const stream = new Stream();
    const d: Drawing = { root, stream, slots: new Map(), free, plants, life, water, dirty: true, animals: [], animalX: Infinity, animalZ: Infinity, animalElapsed: 0, lastView: [], pump: () => {} };
    drawing.current = d;
    let stopped = false, busy = false;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    d.pump = () => {
      if (busy || stopped || document.visibilityState !== "visible") return;
      const next = stream.next();
      if (!next) return;
      busy = true;
      worker.postMessage({ x: next.x, z: next.z, office });
    };
    worker.onmessage = ({ data }: MessageEvent<Chunk>) => {
      busy = false;
      if (stopped) return;
      // A teleport may have invalidated this request. Do not install or cache stale results.
      const installStart = performance.now();
      if (stream.accept(data)) {
        const mesh = d.free.pop()!;
        const g = mesh.geometry;
        (g.getAttribute("position") as BufferAttribute).copyArray(data.positions);
        (g.getAttribute("color") as BufferAttribute).copyArray(data.colors);
        g.getAttribute("position").needsUpdate = true;
        g.getAttribute("color").needsUpdate = true;
        g.computeVertexNormals(); g.computeBoundingSphere();
        mesh.position.set(data.x * CHUNK, 0, data.z * CHUNK);
        mesh.visible = true;
        d.slots.set(data.key, mesh);
        d.dirty = true;
      }
      work.current.installMs += performance.now() - installStart;
      // A worker message is itself a task-sized slice. No render-rate promotion during loading.
      d.pump();
    };
    worker.onerror = (e) => { console.error("Wilds generation worker failed", e.message); busy = true; };
    return () => {
      stopped = true; worker.terminate(); drawing.current = null;
      scene.remove(root);
      for (const mesh of [...plants.values(), ...life.values(), water]) mesh.dispose();
      geometries.forEach((g) => g.dispose()); material.dispose(); waterMaterial.dispose(); lifeMaterial.dispose();
    };
  }, [scene, size]);

  useFrame((_, dt) => {
    frameStart.current = performance.now();
    if (document.visibilityState !== "visible") return;
    const d = drawing.current;
    if (!d) return;
    const { x, z } = camera.position;
    if (d.stream.move(x, z)) {
      work.current.swaps++;
      for (const [key, mesh] of d.slots) if (!d.stream.chunks.has(key)) {
        mesh.visible = false; d.free.push(mesh); d.slots.delete(key);
      }
      d.dirty = true;
    }
    d.pump();
    const o = matrix.current;
    if (d.dirty) {
      const rebuildStart = performance.now();
      for (const mesh of d.plants.values()) mesh.count = 0;
      d.water.count = 0;
      for (const w of d.stream.desired) {
        const chunk = d.stream.chunks.get(w.key);
        if (!chunk) continue;
        if (chunk.wet) {
          o.position.set((w.x + 0.5) * CHUNK, WATER, (w.z + 0.5) * CHUNK); o.rotation.set(0, 0, 0); o.scale.setScalar(1); o.updateMatrix();
          d.water.setMatrixAt(d.water.count++, o.matrix);
        }
        if (w.lod === 2) continue;
        for (const p of chunk.places) {
          const mesh = d.plants.get(`${w.lod}:${p.kind}`);
          if (!mesh) continue;
          o.position.set(p.x, p.y, p.z); o.rotation.set(0, p.yaw, 0); o.scale.setScalar(p.size); o.updateMatrix();
          mesh.setMatrixAt(mesh.count++, o.matrix);
        }
      }
      for (const mesh of [...d.plants.values(), d.water]) mesh.instanceMatrix.needsUpdate = true;
      d.dirty = false;
      work.current.rebuildMs = performance.now() - rebuildStart;
    }
    if (Math.hypot(x - d.animalX, z - d.animalZ) > 3) {
      d.animals = populate(d.animals, x, z, office); d.animalX = x; d.animalZ = z;
    }
    d.animals = d.animals.filter((a) => Math.hypot(a.x - x, a.z - z) < ANIMAL_RADIUS);
    const view = [x, camera.position.y, z, camera.rotation.x, camera.rotation.y];
    const moving = view.some((v, i) => Math.abs(v - (d.lastView[i] ?? Infinity)) > 0.001);
    d.lastView = view;
    d.animalElapsed += dt;
    // Office avatars may keep the canvas at 20fps: outside animals still update at only 5fps
    // when the founder's view is still. Trees and water never animate at either rate.
    if (!moving && d.animalElapsed < 0.2) return;
    stepAnimals(d.animals, x, z, d.animalElapsed, office);
    d.animalElapsed = 0;
    for (const mesh of d.life.values()) mesh.count = 0;
    for (const a of d.animals) {
      const mesh = d.life.get(a.kind)!;
      const pose = gaitPose(a.kind, a.gait ?? 0, a.speed ?? 0);
      (mesh.geometry.getAttribute('instanceGait') as InstancedBufferAttribute).setXY(mesh.count, pose.phase, pose.strength);
      o.position.set(a.x, a.y + pose.hop, a.z); o.rotation.set(0, a.yaw, 0); o.scale.setScalar(1); o.updateMatrix();
      mesh.setMatrixAt(mesh.count++, o.matrix);
    }
    for (const mesh of d.life.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.getAttribute('instanceGait').needsUpdate = true;
    }
  }, -0.5);

  // Opt-in read-only instrumentation. Fixed-size sample ring, no performance history leak.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("wildsMeasure")) return;
    const intervals: number[] = [], costs: number[] = [];
    const samples: object[] = [];
    let seq = 0;
    let last = performance.now();
    const off = addAfterEffect(() => {
      const now = performance.now();
      intervals.push(now - last); costs.push(now - frameStart.current);
      samples.push({ seq: ++seq, time: now, interval: now - last, cpu: now - frameStart.current, z: camera.position.z, calls: gl.info.render.calls, triangles: gl.info.render.triangles, geometries: gl.info.memory.geometries, ...work.current });
      if (samples.length > 240) samples.shift();
      work.current.rebuildMs = 0; work.current.installMs = 0; work.current.swaps = 0;
      last = now;
      if (intervals.length > 240) { intervals.shift(); costs.shift(); }
    });
    const api = { read: () => ({ officeVisible: scene.getObjectByName('Office — visibility gate')?.visible, samples: [...samples], position: camera.position.toArray(), calls: gl.info.render.calls, triangles: gl.info.render.triangles, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, chunks: drawing.current?.stream.chunks.size ?? 0, terrainSlots: drawing.current ? drawing.current.slots.size + drawing.current.free.length : 0, instanceBatches: drawing.current ? drawing.current.plants.size + drawing.current.life.size + 1 : 0, pending: drawing.current?.stream.desired.filter((w) => !drawing.current?.stream.chunks.has(w.key)).length ?? 0, animals: drawing.current?.animals.map((a) => ({ ...a })) ?? [], intervals: [...intervals], costs: [...costs] }) };
    Object.assign(window, { __wilds: api });
    return () => { off(); Reflect.deleteProperty(window, "__wilds"); };
  }, [camera, gl, scene]);
  return null;
}
