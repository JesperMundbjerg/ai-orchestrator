import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

/** Shared by the garden feeders and the projects' jars: millet, sunflower and wheat. */
export const SEED = "#c9a66b";
export const SEEDS = ["#d9bd84", "#b48a52", "#3b3430", "#e2cf9e", "#9c7444"];

let grain: CanvasTexture | null = null;
/** A single small texture, not individual seed meshes. Kept for the office's lifetime. */
export function seedGrain(): CanvasTexture {
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
