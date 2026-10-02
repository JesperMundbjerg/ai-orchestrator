import { generate } from "./land.ts";
import type { Rect } from "../building.ts";

// One request in flight, one small chunk per task. Transfer, never clone, terrain buffers.
self.onmessage = ({ data }: MessageEvent<{ x: number; z: number; office: Rect }>) => {
  const chunk = generate(data.x, data.z, data.office);
  self.postMessage(chunk, { transfer: [chunk.positions.buffer, chunk.colors.buffer] });
};
