// Text painted onto a canvas and used as a texture, so signs and name tags live in the scene
// (depth-sorted, no font download) instead of floating DOM.

import { CanvasTexture, SRGBColorSpace } from "three";

export interface Line {
  text: string;
  size: number;
  color: string;
  weight?: number;
  mono?: boolean;
}

const SANS = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function textTexture(lines: Line[], opts: { width: number; height: number; background?: string; radius?: number; align?: "center" | "left"; padding?: number }): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const g = canvas.getContext("2d")!;
  if (opts.background) {
    g.fillStyle = opts.background;
    g.beginPath();
    g.roundRect(0, 0, opts.width, opts.height, opts.radius ?? 0);
    g.fill();
  }
  const pad = opts.padding ?? 24;
  const total = lines.reduce((h, l) => h + l.size * 1.25, 0);
  let y = (opts.height - total) / 2;
  g.textAlign = opts.align ?? "center";
  g.textBaseline = "top";
  for (const l of lines) {
    g.font = `${l.weight ?? 600} ${l.size}px ${l.mono ? MONO : SANS}`;
    g.fillStyle = l.color;
    const x = g.textAlign === "center" ? opts.width / 2 : pad;
    g.fillText(fit(g, l.text, opts.width - pad * 2), x, y + l.size * 0.12);
    y += l.size * 1.25;
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
