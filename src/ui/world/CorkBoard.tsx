// A team's corkboard in a wooden frame: its name cut out of paper, a paper stickman pinned on for
// each member and a green one under them for each working now, and pinned notes for what it is
// and how it is doing. Painted onto a canvas once for each change of what it says, never per frame.

import { useEffect, useMemo } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";
import { figureGrid, nameLines, wobble, wrap, type Board } from "./corkboard.ts";

/** The canvas, twice as wide as tall; a board's frame keeps the same shape. */
const W = 1280;
const H = 640;
const LETTERS = '"Arial Rounded MT Bold", "Arial Black", ui-sans-serif, system-ui, sans-serif';
const HAND = '"Marker Felt", "Chalkboard SE", "Segoe Print", "Comic Sans MS", ui-sans-serif, sans-serif';
const PINS = ["#e5484d", "#3b82f6", "#f5b50a", "#22a06b", "#a855f7", "#f97316"];
const PAPER = ["#fdf9f0", "#fff4d8", "#f6f1e7"];
const PENCIL = "#3a2716";
const GREEN = "#2fb35c";
const NOTE: Record<string, { paper: string; ink: string }> = {
  blocked: { paper: "#e5484d", ink: "#ffffff" },
  idle: { paper: "#ffe47a", ink: PENCIL },
  offline: { paper: "#d5d9de", ink: "#39414b" },
};

/** A corkboard `width` by `height` (twice as wide as tall), its face towards +z; the frame stands proud of it. */
export function CorkBoard({ board, width, position }: { board: Board; width: number; position: [number, number, number] }) {
  const key = JSON.stringify(board);
  const texture = useMemo(() => corkTexture(board), [key]);
  useEffect(() => () => texture.dispose(), [texture]);
  const height = width / 2;
  const rim = 0.12;
  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[width + rim * 2, height + rim * 2, 0.08]} />
        <meshStandardMaterial color="#8a5a36" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0, 0.041]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function corkTexture(board: Board): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  g.drawImage(cork(), 0, 0);
  let pin = 0;
  const nextPin = () => PINS[(pin++ + Math.abs(Math.round(wobble(board.seed, 99) * 6))) % PINS.length]!;

  // The name, cut out of paper, a letter at a time.
  const nameTop = 22;
  const name = nameLines(board.name, W - 110, 150, 70, (t, s) => measure(g, t, s, LETTERS));
  name.lines.forEach((line, li) => {
    const size = name.size;
    const y = nameTop + (name.lines.length === 1 ? 190 / 2 : size * 1.08 * (li + 0.5));
    paperLine(g, line, W / 2, y, size, board.seed + li, nextPin);
  });

  // The notes down the right: the card, and under it how the team is doing; smaller when there is much to say.
  const column = board.members === null ? { x: W / 2 - 250, w: 500 } : { x: 868, w: 380 };
  const top = 226;
  const room = H - 24 - top;
  const hand = (t: string, s: number) => measure(g, t, s, HAND);
  const notes = (scale: number) => {
    const card = board.card.flatMap((l, i) => {
      const size = Math.round((i ? 34 : 42) * scale);
      return wrap(l, column.w - 44, size, hand, i ? 2 : 3).map((text) => ({ text, size, first: i === 0 }));
    });
    const noteSize = Math.round(40 * scale);
    const note = board.note ? wrap(board.note.text, column.w - 40, noteSize, hand, 4) : [];
    const cardH = 40 + card.reduce((h, l) => h + l.size * 1.2, 0);
    const noteH = note.length ? 44 + note.length * noteSize * 1.15 : 0;
    const gap = note.length ? 24 : 0;
    return { card, note, noteSize, cardH, noteH, gap, total: cardH + gap + noteH };
  };
  let n = notes(1);
  for (let scale = 0.92; n.total > room && scale > 0.5; scale -= 0.08) n = notes(scale);
  let y = top + Math.max(0, (room - n.total) / 2);
  pinned(g, column.x, y, column.w, n.cardH, wobble(board.seed, 40) * 0.035, "#fbfbf6", nextPin(), (x, at) => {
    for (let ly = at + 38; ly < at + n.cardH - 8; ly += 44) line(g, x + 16, ly, x + column.w - 16, "#c3d6ec");
    let ty = at + 24;
    for (const l of n.card) {
      text(g, l.text, x + 22, ty, l.size, l.first ? PENCIL : "#44546a", HAND, "left", 800);
      ty += l.size * 1.2;
    }
  });
  y += n.cardH + n.gap;
  if (board.note && n.note.length) {
    const ink = NOTE[board.note.status] ?? NOTE.idle!;
    pinned(g, column.x + 4, y, column.w - 8, n.noteH, wobble(board.seed, 41) * 0.05, ink.paper, board.note.status === "blocked" ? "#1f2733" : nextPin(), (x, at) => {
      n.note.forEach((l, i) => text(g, l, x + 18, at + 26 + i * n.noteSize * 1.15, n.noteSize, ink.ink, HAND, "left", 800));
    });
  }

  // The members, and the ones working now under them.
  if (board.members !== null) {
    const agents = `${board.members} ${board.members === 1 ? "agent" : "agents"}`;
    figures(g, board.members, agents, "no one yet", 36, top, 810, 200, PAPER[0]!, board.seed, nextPin);
    figures(g, board.working, `${board.working} working now`, "nobody working now", 36, top + 204, 810, 200, GREEN, `${board.seed}/w`, nextPin);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

let corkCanvas: HTMLCanvasElement | null = null;

/** The cork itself, speckled; the same for every board, so made once. */
function cork(): HTMLCanvasElement {
  if (corkCanvas) return corkCanvas;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#c79a64";
  g.fillRect(0, 0, W, H);
  let s = 7;
  const rand = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 0xffffffff;
  const tones = ["#a97a46", "#b5854f", "#d9b27f", "#e3c08f", "#9a6a3a", "#c18f58"];
  for (let i = 0; i < 14000; i++) {
    g.fillStyle = tones[Math.floor(rand() * tones.length)]!;
    g.globalAlpha = 0.35 + rand() * 0.5;
    const r = 0.8 + rand() * 2.6;
    g.beginPath();
    g.ellipse(rand() * W, rand() * H, r, r * (0.5 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  const shade = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.62);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(60,30,5,0.28)");
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);
  return (corkCanvas = canvas);
}

function measure(g: CanvasRenderingContext2D, t: string, size: number, font: string): number {
  g.font = `900 ${size}px ${font}`;
  return g.measureText(t).width;
}

/** A line of paper letters centred on (cx, cy), each a little turned and raised, pinned at each word's start. */
function paperLine(g: CanvasRenderingContext2D, line: string, cx: number, cy: number, size: number, seed: string, pin: () => string) {
  g.font = `900 ${size}px ${LETTERS}`;
  const spacing = size * 0.04;
  const widths = [...line].map((ch) => g.measureText(ch).width + spacing);
  let x = cx - widths.reduce((a, b) => a + b, 0) / 2;
  const chars = [...line];
  chars.forEach((ch, i) => {
    const w = widths[i]!;
    if (ch !== " ") {
      g.save();
      g.translate(x + w / 2, cy + wobble(seed, i) * size * 0.05);
      g.rotate(wobble(seed, i + 500) * 0.09);
      g.font = `900 ${size}px ${LETTERS}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.shadowColor = "rgba(40,20,0,0.55)";
      g.shadowBlur = size * 0.06;
      g.shadowOffsetX = size * 0.025;
      g.shadowOffsetY = size * 0.04;
      g.fillStyle = PAPER[Math.abs(Math.round(wobble(seed, i + 900) * 2)) % PAPER.length]!;
      g.fillText(ch, 0, 0);
      g.shadowColor = "transparent";
      g.lineWidth = Math.max(1, size * 0.012);
      g.strokeStyle = "rgba(90,60,30,0.35)";
      g.strokeText(ch, 0, 0);
      g.restore();
      if (i === 0 || chars[i - 1] === " ") pushPin(g, x + w / 2, cy - size * 0.18, Math.max(7, size * 0.07), pin());
    }
    x += w;
  });
}

/** Stickmen for `count` in a box, with a pencilled caption above them. */
function figures(g: CanvasRenderingContext2D, count: number, caption: string, none: string, left: number, top: number, width: number, height: number, paper: string, seed: string, pin: () => string) {
  text(g, count ? caption : none, left + 6, top, 38, count ? PENCIL : "rgba(58,39,22,0.7)", HAND, "left", 800);
  const box = { x: left, y: top + 46, h: height - 46 };
  const grid = figureGrid(count, width, box.h, 140, 30);
  grid.cells.forEach(([x, y], i) => stickman(g, box.x + x, box.y + y, grid.size, paper, wobble(seed, i) * 0.12, grid.cells.length <= 40 ? pin() : null));
  if (grid.tally !== null) text(g, `×${grid.tally}`, box.x + grid.cells[0]![0] + grid.size * 0.5, box.y + box.h / 2 - grid.size * 0.36, grid.size * 0.7, PENCIL, HAND, "left", 900);
}

function stickman(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, paper: string, tilt: number, pin: string | null) {
  g.save();
  g.translate(cx, cy);
  g.rotate(tilt);
  g.shadowColor = "rgba(40,20,0,0.5)";
  g.shadowBlur = s * 0.05;
  g.shadowOffsetX = s * 0.02;
  g.shadowOffsetY = s * 0.035;
  g.strokeStyle = paper;
  g.fillStyle = paper;
  g.lineWidth = s * 0.1;
  g.lineCap = "round";
  g.lineJoin = "round";
  const r = s * 0.14;
  const head = -s / 2 + r + s * 0.02;
  g.beginPath();
  g.arc(0, head, r, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(0, head + r);
  g.lineTo(0, s * 0.12);
  g.moveTo(-s * 0.24, s * 0.46);
  g.lineTo(0, s * 0.12);
  g.lineTo(s * 0.24, s * 0.46);
  g.moveTo(-s * 0.27, s * 0.02);
  g.lineTo(0, -s * 0.14);
  g.lineTo(s * 0.27, s * 0.02);
  g.stroke();
  g.restore();
  if (pin) pushPin(g, cx, cy + head, Math.max(4, s * 0.06), pin);
}

/** A piece of paper `w` by `h` from (x, y), a little turned, pinned at the top, with `draw` on it. */
function pinned(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, turn: number, paper: string, pin: string, draw: (x: number, y: number) => void) {
  g.save();
  g.translate(x + w / 2, y + h / 2);
  g.rotate(turn);
  g.translate(-w / 2, -h / 2);
  g.shadowColor = "rgba(40,20,0,0.45)";
  g.shadowBlur = 10;
  g.shadowOffsetX = 4;
  g.shadowOffsetY = 6;
  g.fillStyle = paper;
  g.fillRect(0, 0, w, h);
  g.shadowColor = "transparent";
  draw(0, 0);
  g.restore();
  pushPin(g, x + w / 2, y + 10, 11, pin);
}

function pushPin(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  g.save();
  g.shadowColor = "rgba(30,15,0,0.55)";
  g.shadowBlur = r * 0.6;
  g.shadowOffsetX = r * 0.35;
  g.shadowOffsetY = r * 0.5;
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.fillStyle = "rgba(255,255,255,0.55)";
  g.beginPath();
  g.arc(x - r * 0.3, y - r * 0.3, r * 0.32, 0, Math.PI * 2);
  g.fill();
}

function text(g: CanvasRenderingContext2D, t: string, x: number, y: number, size: number, color: string, font: string, align: CanvasTextAlign, weight = 700) {
  g.font = `${weight} ${size}px ${font}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = "top";
  g.fillText(t, x, y);
}

function line(g: CanvasRenderingContext2D, x1: number, y: number, x2: number, color: string) {
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x1, y);
  g.lineTo(x2, y);
  g.stroke();
}
