import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";
import type { Vec2 } from "./layout.ts";

const EYE = 1.62;
const WALK = 4.2;
const RUN = 9;
const FOV = 62;
const FOV_MIN = 18;
const FOV_MAX = 80;

export interface FlyTarget {
  pos: Vec2;
  yaw: number;
  /** Changes on every request, so asking twice for the same place still flies. */
  seq: number;
}

/**
 * You, in first person: WASD or the arrow keys walk, Shift runs, dragging turns the view
 * and scrolling (or pinching, or + and -) zooms. The pointer stays free, so a click still
 * reaches the person under it.
 */
export function Player({ bounds, start, fly }: { bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; start: FlyTarget; fly: FlyTarget | null }) {
  const { camera, gl } = useThree();
  const view = useRef({ yaw: start.yaw, pitch: -0.12, x: start.pos[0], z: start.pos[1], fov: FOV });
  const keys = useRef(new Set<string>());
  const flight = useRef<{ from: { x: number; z: number; yaw: number }; to: FlyTarget; t: number } | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!drag || !(e.buttons & 1)) return;
      const v = view.current;
      // Grab the office and pull it: drag right to turn left, drag up to look down. Zoomed
      // in, the same drag turns less, so what is under the pointer keeps up with it.
      const gain = v.fov / FOV;
      v.yaw -= (e.clientX - drag.x) * 0.004 * gain;
      v.pitch = Math.max(-1.2, Math.min(1.0, v.pitch + (e.clientY - drag.y) * 0.003 * gain));
      drag = { x: e.clientX, y: e.clientY };
      flight.current = null;
    };
    const up = () => void (drag = null);
    const zoom = (factor: number) => {
      const v = view.current;
      v.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, v.fov * factor));
    };
    // A trackpad pinch arrives as a wheel event with ctrlKey and small deltas.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
    const keydown = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      keys.current.add(e.code);
      if (e.code === "Equal" || e.code === "NumpadAdd") zoom(1 / 1.2);
      if (e.code === "Minus" || e.code === "NumpadSubtract") zoom(1.2);
      if (e.code.startsWith("Arrow")) e.preventDefault();
    };
    const keyup = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    el.addEventListener("pointerdown", down);
    el.addEventListener("wheel", wheel, { passive: false });
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("keydown", keydown);
    addEventListener("keyup", keyup);
    addEventListener("blur", blur);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("wheel", wheel);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("keydown", keydown);
      removeEventListener("keyup", keyup);
      removeEventListener("blur", blur);
    };
  }, [gl]);

  useEffect(() => {
    if (!fly) return;
    const v = view.current;
    flight.current = { from: { x: v.x, z: v.z, yaw: v.yaw }, to: fly, t: 0 };
  }, [fly?.seq]);

  useFrame((_, dt) => {
    const v = view.current;
    const k = keys.current;
    const step = Math.min(dt, 0.1);
    const forward = Number(k.has("KeyW") || k.has("ArrowUp")) - Number(k.has("KeyS") || k.has("ArrowDown"));
    const strafe = Number(k.has("KeyD")) - Number(k.has("KeyA"));
    const turn = Number(k.has("ArrowRight")) - Number(k.has("ArrowLeft"));
    if (forward || strafe || turn) flight.current = null;
    v.yaw += turn * 1.8 * step;

    const f = flight.current;
    if (f) {
      f.t = Math.min(1, f.t + step / 1.1);
      const e = f.t * f.t * (3 - 2 * f.t);
      v.x = f.from.x + (f.to.pos[0] - f.from.x) * e;
      v.z = f.from.z + (f.to.pos[1] - f.from.z) * e;
      let dyaw = f.to.yaw - f.from.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      v.yaw = f.from.yaw + dyaw * e;
      v.pitch += (-0.12 - v.pitch) * Math.min(1, step * 4);
      if (f.t >= 1) flight.current = null;
    } else if (forward || strafe) {
      const speed = (k.has("ShiftLeft") || k.has("ShiftRight") ? RUN : WALK) * step;
      const len = Math.hypot(forward, strafe);
      // Yaw 0 looks north (-z), the camera's default; forward is (sin, -cos), right is (cos, sin).
      v.x += ((Math.sin(v.yaw) * forward + Math.cos(v.yaw) * strafe) / len) * speed;
      v.z += ((-Math.cos(v.yaw) * forward + Math.sin(v.yaw) * strafe) / len) * speed;
    }
    v.x = Math.max(bounds.minX + 0.6, Math.min(bounds.maxX - 0.6, v.x));
    v.z = Math.max(bounds.minZ + 0.6, Math.min(bounds.maxZ - 0.6, v.z));
    camera.position.set(v.x, EYE, v.z);
    camera.rotation.set(v.pitch, -v.yaw, 0, "YXZ");
    const lens = camera as PerspectiveCamera;
    if (Math.abs(lens.fov - v.fov) > 0.01) {
      lens.fov += (v.fov - lens.fov) * Math.min(1, step * 12);
      lens.updateProjectionMatrix();
    }
  });

  return null;
}
