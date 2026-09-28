// What an agent looks like, derived from its stable id alone: the same agent always gets the
// same face, hair and clothes, so over time you recognise who is standing there.

export const HAIR_STYLES = ["short", "long", "bun", "spiky", "curly", "bald", "mohawk", "bob"] as const;
export const ACCESSORIES = ["none", "none", "glasses", "headphones", "cap", "beanie"] as const;

export interface Look {
  skin: string;
  hair: string;
  hairStyle: (typeof HAIR_STYLES)[number];
  shirt: string;
  pants: string;
  shoes: string;
  accessory: (typeof ACCESSORIES)[number];
  accent: string;
  /** Overall scale, 0.92–1.08. */
  height: number;
  /** Shoulder width factor, 0.9–1.2. */
  build: number;
}

const SKIN = ["#f6d5bd", "#eab896", "#d49a6a", "#b8794f", "#8d5a3b", "#5e3a24"];
const HAIR = ["#1f1a17", "#3b2a20", "#6b4a2e", "#a8743f", "#d8b36a", "#b5452b", "#8a8f99", "#ece6da", "#2f4a8a", "#7b3fa0"];
const SHIRT = ["#e4572e", "#2e86ab", "#f2c14e", "#4c956c", "#9b5de5", "#f15bb5", "#00a6a6", "#ef8354", "#3d5a80", "#c9184a", "#8ab17d", "#f7f7f2"];
const PANTS = ["#2b3240", "#3d4a5c", "#5a4636", "#1f1f24", "#6b7a8f", "#324d3a", "#7a6a53"];
const SHOES = ["#1b1b1f", "#f2f2f2", "#6b3e26", "#b23a48"];
const ACCENT = ["#ffd166", "#06d6a0", "#118ab2", "#ef476f", "#f4a261", "#e9ecef"];

export function lookFor(id: string): Look {
  // Each trait reads its own slice of a hash, so neighbouring ids do not share traits.
  const bytes = hashBytes(id);
  const pick = <T,>(list: readonly T[], i: number): T => list[bytes[i]! % list.length]!;
  return {
    skin: pick(SKIN, 0),
    hair: pick(HAIR, 1),
    hairStyle: pick(HAIR_STYLES, 2),
    shirt: pick(SHIRT, 3),
    pants: pick(PANTS, 4),
    shoes: pick(SHOES, 5),
    accessory: pick(ACCESSORIES, 6),
    accent: pick(ACCENT, 7),
    height: 0.92 + (bytes[8]! / 255) * 0.16,
    build: 0.9 + (bytes[9]! / 255) * 0.3,
  };
}

/** A small, stable, well-mixed hash (FNV-1a per lane); not for security. */
function hashBytes(text: string): number[] {
  const out: number[] = [];
  for (let lane = 0; lane < 3; lane++) {
    let h = 0x811c9dc5 ^ (lane * 0x9e3779b1);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    out.push(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, (h >>> 24) & 255);
  }
  return out;
}
