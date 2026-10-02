import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Fog, PerspectiveCamera } from "three";
import { away, walkingHeight } from "./wilds/land.ts";
import type { Vec2 } from "./layout.ts";
import { usePace } from "./Pace.tsx";

const EYE = 1.62;
const WALK = 4.2;
const RUN = 9;
const FOV = 62;
const FOV_MIN = 18;
const FOV_MAX = 80;
/** Looking down on the whole ring from above, at full lift. */
const OVERVIEW_PITCH = -1.35;
const LEVEL_PITCH = -0.12;

export interface FlyTarget {
  pos: Vec2;
  yaw: number;
  /** How far up towards the overview, 0 (eye height, the default) to 1. */
  lift?: number;
  /** Changes on every request, so asking twice for the same place still flies. */
  seq: number;
}

/** How far down you look at a lift: level on the floor, steeply down from the top. */
const pitchAt = (lift: number) => LEVEL_PITCH + lift * (OVERVIEW_PITCH - LEVEL_PITCH);

/**
 * You, in first person: WASD or the arrow keys walk, Shift runs, dragging turns the view
 * and scrolling (or pinching, or + and -) zooms. Zooming out past the widest view lifts you
 * up and tilts the view down, for an overview of every corner round your desk; zooming in
 * brings you back down first. The pointer stays free, so a click still reaches the person
 * under it.
 */
export function Player({ bounds, start, fly }: { bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; start: FlyTarget; fly: FlyTarget | null }) {
  const { camera, gl, invalidate, scene } = useThree();
  const pace = usePace();
  // You moved the view: draw it now, and smoothly while it moves.
  const stir = useRef(() => {});
  stir.current = () => {
    const outside = away(bounds, view.current.x, view.current.z) > 4;
    pace?.outside(outside);
    if (outside) pace?.walkedOutside(performance.now());
    else pace?.moved(performance.now());
    invalidate();
  };
  // High enough that the whole floor fits below you.
  const top = Math.max(18, (bounds.maxX - bounds.minX) * 0.72);
  const lifted = start.lift ?? 0;
  const view = useRef({ yaw: start.yaw, pitch: pitchAt(lifted), x: start.pos[0], z: start.pos[1], fov: FOV, lift: lifted, eye: EYE + lifted * (top - EYE) });
  const keys = useRef(new Set<string>());
  const flight = useRef<{ from: { x: number; z: number; yaw: number; lift: number }; to: FlyTarget; t: number } | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!drag || !(e.buttons & 1)) return;
      const v = view.current;
      // The view follows the pointer, as in a first-person game: drag right to turn right, drag
      // up to look up. Zoomed in, the same drag turns less, so what is under the pointer keeps up.
      const gain = v.fov / FOV;
      v.yaw += (e.clientX - drag.x) * 0.004 * gain;
      v.pitch = Math.max(-1.5, Math.min(1.0, v.pitch - (e.clientY - drag.y) * 0.003 * gain));
      drag = { x: e.clientX, y: e.clientY };
      flight.current = null;
      stir.current();
    };
    const up = () => void (drag = null);
    const zoom = (factor: number) => {
      const v = view.current;
      stir.current();
      const lifting = factor > 1 ? v.fov >= FOV_MAX - 0.01 : v.lift > 0;
      if (!lifting) {
        v.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, v.fov * factor));
        return;
      }
      const lift = Math.max(0, Math.min(1, v.lift + Math.log(factor) * 2.2));
      // Tilt down as you rise, in step with it, so what you looked at stays in view.
      v.pitch += (lift - v.lift) * (OVERVIEW_PITCH - LEVEL_PITCH);
      v.pitch = Math.max(-1.5, Math.min(1.0, v.pitch));
      v.lift = lift;
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
      stir.current();
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

  // Reproducible screenshot poses, opt-in only; the long-walk benchmark uses real WASD.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("wildsMeasure")) return;
    const pose = (event: Event) => {
      const p = (event as CustomEvent<{ x: number; z: number; yaw: number; pitch?: number; lift?: number }>).detail;
      const v = view.current;
      v.x = p.x; v.z = p.z; v.yaw = p.yaw; v.pitch = p.pitch ?? LEVEL_PITCH; v.lift = p.lift ?? 0; v.fov = FOV;
      flight.current = null;
      stir.current();
    };
    addEventListener("wilds-measure-pose", pose);
    return () => removeEventListener("wilds-measure-pose", pose);
  }, []);

  useEffect(() => {
    if (!fly) return;
    const v = view.current;
    flight.current = { from: { x: v.x, z: v.z, yaw: v.yaw, lift: v.lift }, to: fly, t: 0 };
    stir.current();
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
      const lift = f.to.lift ?? 0;
      v.lift = f.from.lift + (lift - f.from.lift) * e;
      v.pitch += (pitchAt(lift) - v.pitch) * Math.min(1, step * 4);
      if (f.t >= 1) flight.current = null;
    } else if (forward || strafe) {
      const speed = (k.has("ShiftLeft") || k.has("ShiftRight") ? RUN : WALK) * step;
      const len = Math.hypot(forward, strafe);
      // Yaw 0 looks north (-z), the camera's default; forward is (sin, -cos), right is (cos, sin).
      v.x += ((Math.sin(v.yaw) * forward + Math.cos(v.yaw) * strafe) / len) * speed;
      v.z += ((-Math.cos(v.yaw) * forward + Math.sin(v.yaw) * strafe) / len) * speed;
    }
    // No office-sized clamp: beyond the front door the same controls follow the land.
    // Lakes are traversable at water level in this first version (no underwater camera).
    const ground = walkingHeight(v.x, v.z, bounds);
    const eye = ground + EYE + v.lift * (top - EYE);
    v.eye += (eye - v.eye) * Math.min(1, step * 8);
    const fog = scene.fog as Fog | null;
    if (fog) {
      const reach = Math.max(...[bounds.minX, bounds.maxX].flatMap((x) => [bounds.minZ, bounds.maxZ].map((z) => Math.hypot(x, z)))) + 2;
      const blend = Math.min(1, away(bounds, v.x, v.z) / 20);
      fog.near = (reach + 10) * (1 - blend) + 48 * blend;
      fog.far = (reach * 2 + 60) * (1 - blend) + 112 * blend;
    }
    camera.position.set(v.x, v.eye, v.z);
    camera.rotation.set(v.pitch, -v.yaw, 0, "YXZ");
    const lens = camera as PerspectiveCamera;
    const settling = Math.abs(v.eye - eye) > 0.01 || Math.abs(lens.fov - v.fov) > 0.01;
    const outside = away(bounds, v.x, v.z) > 4;
    pace?.outside(outside);
    if (forward || strafe || turn || f || settling) {
      if (outside) pace?.walkedOutside(performance.now());
      else pace?.moved(performance.now());
    }
    if (Math.abs(lens.fov - v.fov) > 0.01) {
      lens.fov += (v.fov - lens.fov) * Math.min(1, step * 12);
      lens.updateProjectionMatrix();
    }
  }, -1);

  return null;
}
