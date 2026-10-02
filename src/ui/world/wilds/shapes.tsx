// Baked low-poly models: one coloured geometry per kind/LOD, not meshes per tree or limb.
import { BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Kind, Lod } from "./land.ts";
import type { Species } from "./animals.ts";

type V3 = [number, number, number];
class Model {
  parts: BufferGeometry[] = [];
  add(g: BufferGeometry, at: V3, size: V3, hex: string, tilt = 0) {
    const raw = g.index ? g.toNonIndexed() : g;
    if (raw !== g) g.dispose();
    raw.deleteAttribute("uv");
    raw.applyMatrix4(new Matrix4().compose(new Vector3(...at), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt), new Vector3(...size)));
    const c = new Color(hex), colors = new Float32Array(raw.getAttribute("position").count * 3);
    for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
    raw.setAttribute("color", new Float32BufferAttribute(colors, 3));
    this.parts.push(raw);
  }
  blob(at: V3, size: V3, color: string, detail = 0) { this.add(new IcosahedronGeometry(1, detail), at, size, color); }
  box(at: V3, size: V3, color: string, tilt = 0) { this.add(new BoxGeometry(), at, size, color, tilt); }
  finish() { const out = mergeGeometries(this.parts)!; this.parts.forEach((p) => p.dispose()); return out; }
}
export function scenery(kind: Kind, lod: Lod): BufferGeometry {
  const m = new Model();
  if (kind === "pine" || kind === "oak") {
    m.add(new CylinderGeometry(0.12, 0.22, 3, lod === 0 ? 6 : 4), [0, 1.5, 0], [1, 1, 1], "#72573e");
    if (kind === "pine") {
      for (let i = 0; i < (lod === 0 ? 3 : 1); i++) m.add(new ConeGeometry(lod === 0 ? 1.7 - i * 0.35 : 1.6, lod === 0 ? 2.8 : 4.6, lod === 0 ? 7 : 5), [0, lod === 0 ? 2.8 + i * 1.05 : 3.7, 0], [1, 1, 1], ["#426b4f", "#537f50", "#659454"][i]!);
    } else {
      m.blob([0, 4, 0], [2.1, 1.9, 2], "#70954b", lod === 0 ? 1 : 0);
      if (lod === 0) for (let i = 0; i < 3; i++) m.blob([Math.sin(i * 2.1) * 1.4, 3.6, Math.cos(i * 2.1) * 1.3], [1.2, 1.2, 1.3], ["#7e9f50", "#638946", "#8aab58"][i]!);
    }
  } else if (kind === "rock") {
    m.blob([0, 0.35, 0], [0.85, 0.65, 0.7], "#99958a", lod === 0 ? 1 : 0);
  } else {
    const n = kind === "shore" ? 6 : 5;
    for (let i = 0; i < n; i++) {
      const a = i * 2.4, x = Math.sin(a) * 0.18, z = Math.cos(a) * 0.18, h = kind === "shore" ? 0.9 + i * 0.08 : 0.25 + i * 0.06;
      m.add(new ConeGeometry(0.06, h, 3), [x, h / 2, z], [1, 1, 1], kind === "shore" ? "#89985c" : "#9ead68", (i - 2) * 0.12);
      if (kind === "shore" && i % 2 === 0) m.blob([x, h, z], [0.055, 0.14, 0.055], "#66523c");
    }
  }
  return m.finish();
}
export function creature(kind: Species): BufferGeometry {
  const m = new Model();
  if (kind === "deer") {
    m.blob([0, 0.95, 0], [0.32, 0.4, 0.67], "#b7895b");
    m.blob([0, 1.43, 0.43], [0.19, 0.48, 0.23], "#bb9269");
    m.blob([0, 1.8, 0.66], [0.2, 0.2, 0.33], "#c5a177");
    m.blob([0, 1.78, 0.93], [0.11, 0.09, 0.08], "#3b352c");
    for (const s of [-1, 1]) {
      m.blob([s * 0.23, 2.02, 0.53], [0.12, 0.22, 0.07], "#ad8158");
      m.blob([s * 0.17, 1.86, 0.76], [0.035, 0.035, 0.035], "#252c28");
      for (const z of [-0.42, 0.4]) m.box([s * 0.23, 0.42, z], [0.09, 0.84, 0.1], "#846445");
    }
    m.blob([0, 1.05, -0.65], [0.15, 0.18, 0.15], "#e8dcc7");
  } else if (kind === "rabbit") {
    m.blob([0, 0.25, 0], [0.22, 0.25, 0.32], "#b4a38d", 1);
    m.blob([0, 0.44, 0.24], [0.17, 0.17, 0.19], "#c4b49e");
    for (const s of [-1, 1]) {
      m.blob([s * 0.085, 0.69, 0.22], [0.045, 0.22, 0.06], "#ab967f");
      m.blob([s * 0.135, 0.47, 0.33], [0.026, 0.026, 0.026], "#252c28");
      m.blob([s * 0.17, 0.08, 0.11], [0.11, 0.08, 0.18], "#b4a38d");
    }
    m.blob([0, 0.27, -0.31], [0.12, 0.12, 0.12], "#efe8d8");
  } else {
    const duck = kind === "duck";
    m.blob([0, 0.15, 0], [0.22, 0.16, 0.36], duck ? "#b7aa8f" : "#566879");
    m.blob([0, 0.37, 0.25], [0.13, 0.14, 0.15], duck ? "#3c7157" : "#425568");
    m.box([0, 0.34, 0.41], [0.1, 0.045, 0.17], "#d2a34f");
    if (!duck) for (const s of [-1, 1]) m.blob([s * 0.4, 0.16, -0.04], [0.45, 0.04, 0.22], "#728393");
  }
  return m.finish();
}
