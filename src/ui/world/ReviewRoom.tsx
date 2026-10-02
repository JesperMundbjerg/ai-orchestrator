import { CanvasTexture, SRGBColorSpace } from "three";
import type { ReviewExcerpt, WorldAgent } from "../../shared/types.ts";
import { projectedExcerpt } from "./meeting.ts";
import type { Room } from "./building.ts";
import { useTexture } from "./useTexture.ts";

// Read-only sources: FysikLab docs/ARCHITECTURE.md, docs/DEV_FLOW.md and
// space-app/lib/db/index.md (2026-07). These are maps, not proposed architecture.
function canvas(width: number, height: number) {
  const c = document.createElement("canvas"); c.width = width; c.height = height;
  return { c, g: c.getContext("2d")! };
}
function texture(c: HTMLCanvasElement) { const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; return t; }

export function architectureBoard(room: number) {
  const { c, g } = canvas(1200, 800);
  g.fillStyle = "#faf8eb"; g.fillRect(0, 0, 1200, 800);
  g.fillStyle = "#314954"; g.font = "bold 44px cursive"; g.fillText("FysikLab / ideas we can trace", 45, 68);
  const ink = ["#296f96", "#a54b63", "#36806b"];
  const box = (x: number, y: number, w: number, label: string, color: string) => {
    g.strokeStyle = color; g.lineWidth = 4; g.beginPath();
    g.moveTo(x + 2, y); g.lineTo(x + w, y + 3); g.lineTo(x + w - 2, y + 70); g.lineTo(x, y + 68); g.closePath(); g.stroke();
    g.font = "27px cursive"; g.fillStyle = color; g.fillText(label, x + 16, y + 43);
  };
  const arrow = (x: number, y: number, to: number, color: string) => {
    g.strokeStyle = color; g.lineWidth = 4; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo((x + to) / 2, y - 5, to, y); g.lineTo(to - 12, y - 9); g.moveTo(to, y); g.lineTo(to - 12, y + 10); g.stroke();
  };
  const row = (y: number, heading: string, labels: string[], color: string) => {
    g.fillStyle = color; g.font = "bold 29px cursive"; g.fillText(heading, 45, y);
    labels.forEach((label, i) => { box(45 + i * 380, y + 24, 330, label, color); if (i < 2) arrow(378 + i * 380, y + 59, 420 + i * 380, color); });
  };
  if (room === 0) {
    row(130, "01 / two ways to explore", ["Next.js / EN + DA", "LessonPage / Lab", "React + R3F"], ink[0]!);
    row(290, "02 / guided lessons", ["LessonPage", "Chapter > Step", "caption beats"], ink[1]!);
    row(450, "03 / learner data (verified account)", ["progress / me API", "lib/db", "Supabase"], ink[2]!);
  } else {
    row(130, "01 / comments become work", ["preview comments", "shared SQLite", "Mission Control"], ink[0]!);
    row(290, "02 / ownership, then verification", ["assigned lane", "fix + review", "verify marker"], ink[1]!);
    row(450, "03 / lab: keep the maths pure", ["URL / useSimParams", "physics.ts / SI", "React + R3F"], ink[2]!);
  }
  for (const [i, text] of ["keep it simple", "test the boundary", "show, then review"].entries()) {
    g.save(); g.translate(100 + i * 380, 660); g.rotate((i - 1) * 0.035);
    g.fillStyle = ["#f5dd80", "#eed0d4", "#c9dfbb"][i]!; g.fillRect(0, 0, 290, 87);
    g.fillStyle = "#575346"; g.font = "25px cursive"; g.fillText(text, 15, 48); g.restore();
  }
  return texture(c);
}

export function codeSlide(excerpt: ReviewExcerpt | null, name: string | null) {
  const { c, g } = canvas(1440, 820);
  g.fillStyle = "#202f3a"; g.fillRect(0, 0, 1440, 820);
  g.fillStyle = "#b6d5ce"; g.font = "26px monospace"; g.fillText("FYSIKLAB   /   CREATIVE REVIEW", 48, 58);
  g.fillStyle = "#f6d894"; g.font = "30px monospace";
  g.fillText(excerpt ? excerpt.path.slice(0, 70) : "A little space to think", 48, 119);
  if (excerpt) {
    g.font = "22px monospace";
    excerpt.lines.forEach((line, i) => {
      g.fillStyle = "#809da7"; g.fillText(String(excerpt.startLine + i).padStart(4), 36, 182 + i * 43);
      g.fillStyle = /^\s*\/\//.test(line) ? "#a0c7a5" : "#e0eaf0"; g.fillText(line.slice(0, 94), 115, 182 + i * 43);
    });
  } else {
    g.fillStyle = "#d4e0df"; g.font = "36px cursive"; g.fillText("Read carefully. Sketch together. Make it simpler.", 100, 380);
    g.font = "25px monospace"; g.fillText(name ? "No safe source available in this checkout." : "Bring a review to put code on the screen.", 100, 457);
  }
  g.fillStyle = "#a8c4c8"; g.font = "24px monospace"; g.fillText(name ? `${name} / reviewing` : "Room ready / bring an idea", 48, 772);
  return texture(c);
}

export function ReviewRoom({ room, index, reviewer }: { room: Room; index: number; reviewer: WorldAgent | null }) {
  const excerpt = projectedExcerpt(reviewer);
  const board = useTexture(() => architectureBoard(index), [index]);
  const screen = useTexture(() => codeSlide(excerpt, reviewer?.name ?? null), [JSON.stringify(excerpt), reviewer?.name]);
  return <group position={[room.center[0], 0, room.center[1]]} rotation-y={room.facing}>
    <group position={[-room.half[0] + 0.13, 2.45, 0]} rotation-y={Math.PI / 2}>
      <mesh><boxGeometry args={[3.74, 2.54, 0.08]} /><meshStandardMaterial color="#ba936c" /></mesh>
      <mesh position-z={0.045}><planeGeometry args={[3.6, 2.4]} /><meshBasicMaterial map={board} toneMapped={false} /></mesh>
    </group>
    <group position={[0, 2.6, 0.24 - room.half[1]]}>
      <mesh><boxGeometry args={[4.76, 2.78, 0.08]} /><meshStandardMaterial color="#e4dfce" /></mesh>
      <mesh position-z={0.045}><planeGeometry args={[4.6, 2.62]} /><meshBasicMaterial map={screen} toneMapped={false} /></mesh>
    </group>
    {/* A tabletop projector, lens aimed at the pull-down screen. */}
    <mesh position={[0, 0.9, 1.1]} castShadow><boxGeometry args={[0.48, 0.24, 0.37]} /><meshStandardMaterial color="#ece9de" /></mesh>
    <mesh position={[0.1, 0.92, 0.9]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.095, 0.095, 0.09, 10]} /><meshStandardMaterial color="#344654" /></mesh>
    <mesh position={[0.1, 0.92, 0.85]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.07, 0.07, 0.01, 10]} /><meshBasicMaterial color="#b3dfeb" /></mesh>
    <mesh position={[-0.14, 1.023, 1.18]}><boxGeometry args={[0.045, 0.006, 0.045]} /><meshBasicMaterial color="#78b7a0" /></mesh>
    {[0, 1, 2].map((i) => <mesh key={`vent-${i}`} position={[0, 0.84 + i * 0.045, 1.288]}><boxGeometry args={[0.32, 0.012, 0.006]} /><meshStandardMaterial color="#59636b" /></mesh>)}
    {[0, 1, 2].map((i) => <mesh key={i} position={[-0.35 + i * 0.34, 0.775, -0.15 + i * 0.28]} rotation-y={i * 0.3}><boxGeometry args={[0.23, 0.008, 0.23]} /><meshStandardMaterial color={["#efd481", "#c5dbac", "#e7b8bd"][i]} /></mesh>)}
  </group>;
}
