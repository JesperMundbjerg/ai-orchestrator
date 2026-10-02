// What each team member makes in their room instead of sitting at a desk. Pure: which craft a
// place in a room gets, what its station is made of, and how far the piece on it has come.
//
//   where    a station stands where the plan puts a desk (building.ts), in the same
//            footprint (DESK_SIZE, shrunk by the desk's scale), so everything that kept walkers
//            and rooms clear of desks keeps them clear of stations. Its person stands where the
//            desk's did, SEAT in front of it, facing it
//   what     woodwork (a bench, a chair or table on it), painting (an easel), pottery (a wheel),
//            sculpture (a bust on a stand) and weaving (an upright loom). The crafts go round a
//            room's places from a start its team picks, so neighbours make different things;
//            the lead has a larger station of their own at the front
//   progress the piece grows a stage every STAGE_S its maker works, stands finished a while, and
//            a new one is started. A free place, or one whose maker is away, keeps its piece
//            where it got to; every place starts somewhere along, so a room looks lived in

import { DESK_SIZE, type Corner, type Desk, type Vec2 } from "./spatial.ts";

export type Craft = "woodwork" | "painting" | "pottery" | "sculpture" | "weaving";

export const CRAFTS: Craft[] = ["woodwork", "painting", "pottery", "sculpture", "weaving"];
/** What a lead makes, at a station as wide as a lead's desk. */
export const LEAD_CRAFTS: Craft[] = ["woodwork", "painting", "weaving"];

/** A piece grows a stage every this many seconds of work. */
export const STAGE_S = 15;
/** How many stages a piece has before it is finished. */
export const STAGES: Record<Craft, number> = { woodwork: 5, painting: 6, pottery: 5, sculpture: 5, weaving: 7 };
/** A finished piece stands this many stages before the next is started. */
const HOLD = 2;

export type Shape = "box" | "round" | "ball";
export type Stuff = "wood" | "matte" | "metal" | "clay" | "cloth";

/** A part of a station or of a piece, in the station's frame: x across, y up, +z away from its maker. */
export interface Part {
  shape: Shape;
  stuff: Stuff;
  at: [number, number, number];
  size: [number, number, number];
  color: string;
  /** Turned about y, then tipped about x (the top away from the maker), then leaned about z. */
  turn?: number;
  tilt?: number;
  roll?: number;
  /** Turns with the wheel, round the station's middle, while its maker works. */
  spin?: boolean;
}

export interface Station {
  /** Stable while its place is: the maker's id, or the room and place for a free one. */
  key: string;
  desk: Desk;
  craft: Craft;
  lead: boolean;
  /** Picks the piece's colours and where it starts. */
  seed: number;
}

/** A hash of a string, the same every time: FNV-1a. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** A room's stations, one on each of its desks, the crafts going round its places from where its team starts. */
export function stationsFor(desks: Desk[], room: string): Station[] {
  const start = hash(room);
  let n = 0;
  return desks.map((desk, i) => {
    const lead = desk.kind === "lead";
    const craft = lead ? LEAD_CRAFTS[start % LEAD_CRAFTS.length]! : CRAFTS[(start + n++) % CRAFTS.length]!;
    return { key: desk.occupantId ?? `${room}#${i}`, desk, craft, lead, seed: hash(`${room}#${i}`) };
  });
}

/** Every team's stations. */
export function studio(corners: Corner[]): Station[] {
  return corners.flatMap((c) => stationsFor(c.desks, c.team.id));
}

/** What each member in a room makes, by their id. */
export function crafters(corners: Corner[]): Map<string, Craft> {
  return new Map(studio(corners).filter((s) => s.desk.occupantId).map((s) => [s.desk.occupantId!, s.craft]));
}

/** How far a piece has come after this many seconds of work: 0 just started, STAGES finished; then the next one. */
export function stageAt(craft: Craft, seconds: number): number {
  const cycle = STAGES[craft] + 1 + HOLD;
  return Math.min(STAGES[craft], Math.floor(Math.max(0, seconds) / STAGE_S) % cycle);
}

/** Where a station's piece starts, so a room looks lived in: somewhere short of finished. */
export function startSeconds(station: Station): number {
  return (station.seed % STAGES[station.craft]) * STAGE_S + (station.seed % 7);
}

/** A point in a station's frame on the floor. */
export function onFloor(desk: Desk, [x, z]: Vec2): Vec2 {
  const s = desk.scale;
  const c = Math.cos(desk.facing);
  const n = Math.sin(desk.facing);
  return [desk.pos[0] + x * s * c + z * s * n, desk.pos[1] - x * s * n + z * s * c];
}

const box = (stuff: Stuff, at: Part["at"], size: Part["size"], color: string, more: Partial<Part> = {}): Part => ({ shape: "box", stuff, at, size, color, ...more });
const round = (stuff: Stuff, at: Part["at"], size: Part["size"], color: string, more: Partial<Part> = {}): Part => ({ shape: "round", stuff, at, size, color, ...more });
const ball = (stuff: Stuff, at: Part["at"], size: Part["size"], color: string, more: Partial<Part> = {}): Part => ({ shape: "ball", stuff, at, size, color, ...more });

/** A stick from one point to another, in the plane across the station or the one along it. */
function stick(stuff: Stuff, from: [number, number, number], to: [number, number, number], thick: number, color: string): Part {
  const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(dx, dy, dz);
  const mid: [number, number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
  return box(stuff, mid, [thick, length, thick], color, { tilt: Math.atan2(dz, Math.hypot(dx, dy)), roll: -Math.atan2(dx, dy) });
}

/** Half the station's width: a crew member's is a console desk's, a lead's a lead's desk's. */
const halfWidth = (lead: boolean) => DESK_SIZE[lead ? "lead" : "console"][0] / 2;

const WOOD = "#c8a171";
const DARK_WOOD = "#8a6a4a";
const PALE_WOOD = "#e0c49a";

/** The station itself: what stays however far the piece has come. */
export function stationParts(craft: Craft, lead: boolean): Part[] {
  const hw = halfWidth(lead);
  switch (craft) {
    case "woodwork": {
      const out = [box("wood", [0, 0.84, 0], [hw * 2 - 0.1, 0.06, 0.6], WOOD), box("wood", [0, 0.2, 0], [hw * 2 - 0.3, 0.03, 0.5], "#9c7a55")];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box("wood", [sx * (hw - 0.12), 0.405, sz * 0.24], [0.07, 0.81, 0.07], DARK_WOOD));
      out.push(box("wood", [0, 0.235, -0.1], [hw * 2 - 0.5, 0.04, 0.12], PALE_WOOD), box("wood", [0.05, 0.235, 0.08], [hw * 2 - 0.6, 0.04, 0.14], "#d2ad7c"));
      // A vice at the maker's left, and a plank in it to saw.
      out.push(box("metal", [-(hw - 0.14), 0.92, -0.26], [0.16, 0.1, 0.08], "#4a5058"));
      out.push(box("wood", [-(hw - 0.32), 0.9, -0.2], [0.42, 0.03, 0.1], PALE_WOOD));
      return out;
    }
    case "painting": {
      const [cw, ch, cy] = lead ? [1.2, 0.7, 1.34] : [0.64, 0.52, 1.28];
      const legX = lead ? 0.55 : 0.28;
      const top = cy + ch / 2 + 0.12;
      const out = [
        stick("wood", [-legX, 0, -0.12], [-legX * 0.35, top, 0.02], 0.04, DARK_WOOD),
        stick("wood", [legX, 0, -0.12], [legX * 0.35, top, 0.02], 0.04, DARK_WOOD),
        stick("wood", [0, 0, 0.3], [0, top - 0.1, 0.04], 0.035, DARK_WOOD),
        box("wood", [0, cy - ch / 2 - 0.03, -0.07], [cw + 0.12, 0.03, 0.08], DARK_WOOD),
        ...canvas(cw, ch, cy, [{ u: 0, v: 0, w: 1, h: 1, color: "#f4f1ea" }], 0),
      ];
      // A stool beside it with the paint pots.
      const sx = hw - 0.16;
      out.push(box("wood", [sx, 0.6, -0.12], [0.24, 0.03, 0.24], WOOD), box("wood", [sx, 0.3, -0.12], [0.05, 0.6, 0.05], DARK_WOOD));
      ["#d9534f", "#f0c040", "#3f7fd0", "#4f9a5a"].forEach((c, i) => out.push(round("matte", [sx - 0.06 + (i % 2) * 0.12, 0.655, -0.18 + Math.floor(i / 2) * 0.12], [0.07, 0.08, 0.07], c)));
      return out;
    }
    case "pottery": {
      const out = [
        round("matte", [0, 0.35, 0], [0.5, 0.7, 0.5], "#6d7680"),
        round("matte", [0, 0.74, 0], [0.62, 0.08, 0.62], "#8a939c"),
        round("metal", [0, 0.79, 0], [0.34, 0.03, 0.34], "#b8bec6"),
        // A mark on the wheel's rim, so you see it turn.
        box("matte", [0.14, 0.8, 0], [0.05, 0.012, 0.03], "#d8dde3", { spin: true }),
      ];
      // A shelf at the side with pots that are done.
      const sx = -(hw - 0.14);
      out.push(box("wood", [sx, 0.25, 0.05], [0.24, 0.5, 0.4], DARK_WOOD));
      out.push(round("clay", [sx, 0.58, -0.05], [0.14, 0.16, 0.14], "#b8643c"), ball("clay", [sx, 0.58, 0.14], [0.16, 0.14, 0.16], "#6f8fa8"));
      return out;
    }
    case "sculpture": {
      const out = [box("matte", [0, 0.47, 0], [0.4, 0.94, 0.4], "#d9d4ca"), round("metal", [0, 0.96, 0], [0.36, 0.04, 0.36], "#9aa1a9")];
      const sx = hw - 0.16;
      out.push(box("wood", [sx, 0.15, 0.1], [0.26, 0.3, 0.3], DARK_WOOD), box("matte", [sx, 0.36, 0.1], [0.18, 0.12, 0.16], "#e8e3d8"));
      return out;
    }
    case "weaving": {
      const lw = lead ? 1.7 : 1.1;
      const out: Part[] = [];
      for (const sx of [-1, 1]) {
        out.push(box("wood", [(sx * lw) / 2, 0.85, 0.05], [0.06, 1.7, 0.08], DARK_WOOD));
        out.push(box("wood", [(sx * lw) / 2, 0.02, 0.05], [0.08, 0.04, 0.5], DARK_WOOD));
      }
      out.push(box("wood", [0, 1.64, 0.05], [lw + 0.1, 0.07, 0.08], WOOD), box("wood", [0, 0.42, 0.05], [lw + 0.1, 0.07, 0.08], WOOD));
      const threads = lead ? 15 : 9;
      for (let i = 0; i < threads; i++) out.push(box("cloth", [-lw / 2 + 0.08 + (i * (lw - 0.16)) / (threads - 1), 1.03, 0.05], [0.008, 1.18, 0.008], "#efe6d2"));
      // Balls of yarn at its feet.
      ["#c0504d", "#e2a93b"].forEach((c, i) => out.push(ball("cloth", [(i ? 1 : -1) * (hw - 0.1), 0.07, 0.22], [0.14, 0.14, 0.14], c)));
      return out;
    }
  }
}

/** A rectangle painted on a canvas, in the canvas's own units: u across and v up, from -0.5 to 0.5. */
interface Stroke {
  u: number;
  v: number;
  w: number;
  h: number;
  color: string;
}

const CANVAS_TILT = 0.1;

/** A canvas on an easel, leaning back, with strokes painted on its face towards the maker. */
function canvas(cw: number, ch: number, cy: number, strokes: Stroke[], layer: number): Part[] {
  const cz = 0.0;
  return strokes.map((s, i) => {
    const d = layer ? 0.016 + i * 0.002 : 0;
    const v = s.v * ch;
    const at: [number, number, number] = [s.u * cw, cy + v * Math.cos(CANVAS_TILT) + d * Math.sin(CANVAS_TILT), cz + v * Math.sin(CANVAS_TILT) - d * Math.cos(CANVAS_TILT)];
    return box(layer ? "cloth" : "matte", at, [s.w * cw, s.h * ch, layer ? 0.004 : 0.03], s.color, { tilt: CANVAS_TILT });
  });
}

/** Three pictures a painter works on: a landscape, the sea, and blocks of colour. */
const PICTURES: Stroke[][] = [
  [
    { u: 0, v: 0.2, w: 0.96, h: 0.56, color: "#8fc3e8" },
    { u: 0, v: -0.27, w: 0.96, h: 0.42, color: "#7fb069" },
    { u: 0.28, v: 0.3, w: 0.14, h: 0.18, color: "#f5d04a" },
    { u: -0.2, v: -0.08, w: 0.56, h: 0.16, color: "#4f8a4a" },
    { u: 0.12, v: -0.18, w: 0.05, h: 0.26, color: "#6b4a2f" },
    { u: 0.12, v: 0.04, w: 0.2, h: 0.24, color: "#2f6b3a" },
  ],
  [
    { u: 0, v: 0.25, w: 0.96, h: 0.46, color: "#f2c6a0" },
    { u: 0, v: -0.23, w: 0.96, h: 0.5, color: "#3f78b0" },
    { u: -0.25, v: 0.2, w: 0.16, h: 0.16, color: "#e8734a" },
    { u: 0, v: -0.02, w: 0.96, h: 0.04, color: "#9cc6e0" },
    { u: 0.15, v: -0.1, w: 0.26, h: 0.07, color: "#f4f1ea" },
    { u: 0.18, v: 0.03, w: 0.03, h: 0.2, color: "#7a5a40" },
  ],
  [
    { u: -0.24, v: 0.24, w: 0.46, h: 0.46, color: "#d9534f" },
    { u: 0.24, v: 0.24, w: 0.46, h: 0.46, color: "#f0c040" },
    { u: -0.24, v: -0.24, w: 0.46, h: 0.46, color: "#3f7fd0" },
    { u: 0.24, v: -0.24, w: 0.46, h: 0.46, color: "#f4f1ea" },
    { u: 0, v: 0, w: 0.04, h: 0.96, color: "#1c1f24" },
    { u: 0, v: 0, w: 0.96, h: 0.04, color: "#1c1f24" },
  ],
];

const CLAYS = ["#b8643c", "#c98b5a", "#9c5a3c"];
const GLAZES = ["#6f8fa8", "#4f8a6a", "#c9a640", "#a8506a"];
const YARNS = [["#c0504d", "#e2a93b", "#f4f1ea", "#3f6f8f"], ["#4f8a6a", "#d7c7a0", "#8a5a8f", "#e2a93b"], ["#3f78b0", "#f4f1ea", "#d9534f", "#2f4a6a"]];

/** Something being made from boards: its top first, upside down, the legs one by one, then turned over (and given a back if it is a chair). */
function joinery(lead: boolean, stage: number): Part[] {
  const [w, d, legH, back] = lead ? [0.9, 0.5, 0.42, false] : [0.36, 0.34, 0.34, true];
  const y0 = 0.87;
  const x0 = lead ? 0.2 : 0.18;
  const leg = (sx: number, sz: number, bottom: number) => box("wood", [x0 + sx * (w / 2 - 0.03), bottom + legH / 2, sz * (d / 2 - 0.03)], [0.035, legH, 0.035], PALE_WOOD);
  const corners: Vec2[] = [[-1, -1], [1, 1], [1, -1], [-1, 1]];
  if (stage < STAGES.woodwork) {
    const out = [box("wood", [x0, y0 + 0.015, 0], [w, 0.03, d], "#d9b98c")];
    for (let i = 0; i < stage; i++) out.push(leg(corners[i]![0], corners[i]![1], y0 + 0.03));
    // The legs still to fit, lying beside it.
    for (let i = stage; i < 4; i++) out.push(box("wood", [x0 - w / 2 - 0.1 - (lead ? 0.1 : 0), y0 + 0.02 + (i - stage) * 0.036, 0.1], [0.035, 0.035, legH], PALE_WOOD, { turn: 0 }));
    return out;
  }
  const out = corners.map(([sx, sz]) => leg(sx, sz, y0));
  out.push(box("wood", [x0, y0 + legH + 0.015, 0], [w, 0.03, d], "#d9b98c"));
  if (back) out.push(box("wood", [x0, y0 + legH + 0.2, d / 2 - 0.02], [w, 0.34, 0.03], "#d9b98c"));
  return out;
}

/** A pot on the wheel: a lump of clay drawn up, bellied, necked, and last glazed. */
function pot(stage: number, seed: number): Part[] {
  const clay = CLAYS[seed % CLAYS.length]!;
  const y = 0.805;
  switch (stage) {
    case 0:
      return [ball("clay", [0, y + 0.05, 0], [0.22, 0.12, 0.22], clay)];
    case 1:
      return [round("clay", [0, y + 0.08, 0], [0.2, 0.16, 0.2], clay)];
    case 2:
      return [round("clay", [0, y + 0.13, 0], [0.18, 0.26, 0.18], clay)];
    case 3:
      return [round("clay", [0, y + 0.1, 0], [0.22, 0.2, 0.22], clay), round("clay", [0, y + 0.24, 0], [0.15, 0.1, 0.15], clay)];
    default: {
      const color = stage >= STAGES.pottery ? GLAZES[seed % GLAZES.length]! : clay;
      const out = [
        round("clay", [0, y + 0.03, 0], [0.14, 0.06, 0.14], color),
        ball("clay", [0, y + 0.15, 0], [0.26, 0.24, 0.26], color),
        round("clay", [0, y + 0.3, 0], [0.1, 0.12, 0.1], color),
        round("clay", [0, y + 0.37, 0], [0.14, 0.03, 0.14], color),
      ];
      if (stage >= STAGES.pottery) out.push(round("clay", [0, y + 0.15, 0], [0.265, 0.03, 0.265], "#f4f1ea"));
      return out;
    }
  }
}

/** A bust cut from a block on the stand: roughed out, shoulders and head blocked in, then rounded and finished. */
function bust(stage: number, seed: number): Part[] {
  const stone = seed % 2 ? "#e8e3d8" : "#b8744c";
  const y = 0.98;
  const out: Part[] = [];
  if (stage === 0) out.push(box("clay", [0, y + 0.25, 0], [0.3, 0.5, 0.28], stone));
  else if (stage === 1) out.push(box("clay", [0, y + 0.125, 0], [0.3, 0.25, 0.28], stone), box("clay", [0, y + 0.375, 0], [0.24, 0.25, 0.22], stone));
  else if (stage === 2) out.push(box("clay", [0, y + 0.08, 0], [0.3, 0.16, 0.2], stone), box("clay", [0, y + 0.3, 0], [0.18, 0.28, 0.18], stone));
  else {
    const smooth = stage >= 4;
    out.push(smooth ? ball("clay", [0, y + 0.08, 0], [0.34, 0.18, 0.2], stone) : box("clay", [0, y + 0.08, 0], [0.32, 0.16, 0.2], stone));
    out.push(round("clay", [0, y + 0.2, 0], [0.08, 0.1, 0.08], stone));
    out.push(smooth ? ball("clay", [0, y + 0.34, 0], [0.17, 0.22, 0.19], stone) : box("clay", [0, y + 0.34, 0], [0.16, 0.2, 0.18], stone));
    if (stage >= STAGES.sculpture) out.push(box("clay", [0, y + 0.33, -0.1], [0.03, 0.05, 0.03], stone), ball("clay", [0, y + 0.41, 0.02], [0.18, 0.1, 0.18], stone));
  }
  // Chips round the stand's foot, more as the work goes on.
  for (let i = 0; i < Math.min(6, stage * 2); i++) {
    const a = (seed % 13) + i * 2.1;
    out.push(box("clay", [Math.sin(a) * 0.3, 0.015, Math.cos(a) * 0.26], [0.05, 0.03, 0.04], stone, { turn: a }));
  }
  return out;
}

/** The piece on a station at a stage: what grows as its maker works. */
export function pieceParts(craft: Craft, lead: boolean, stage: number, seed: number): Part[] {
  switch (craft) {
    case "woodwork":
      return joinery(lead, stage);
    case "painting": {
      const [cw, ch, cy] = lead ? [1.2, 0.7, 1.34] : [0.64, 0.52, 1.28];
      return canvas(cw, ch, cy, PICTURES[seed % PICTURES.length]!.slice(0, stage), 1);
    }
    case "pottery":
      return pot(stage, seed);
    case "sculpture":
      return bust(stage, seed);
    case "weaving": {
      const lw = lead ? 1.7 : 1.1;
      const yarn = YARNS[seed % YARNS.length]!;
      // A band of cloth a stage, from the bottom beam up, and the first rows of the next.
      const band = 1.1 / STAGES.weaving;
      const out = Array.from({ length: stage }, (_, i) => box("cloth", [0, 0.46 + band * (i + 0.5), 0.05], [lw - 0.12, band, 0.02], yarn[i % yarn.length]!));
      if (stage < STAGES.weaving) out.push(box("cloth", [0, 0.46 + band * (stage + 0.15), 0.05], [lw - 0.12, band * 0.3, 0.02], yarn[stage % yarn.length]!));
      return out;
    }
  }
}
