// Images you paste or drop into the office or the inbox. Each is stored once under the data
// directory, named by a random id and the type its bytes show, and served back for the thread.
// An agent gets the file's absolute path in the text it is typed or handed, never the bytes.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InboxError } from "./inbox.ts";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** A message or an answer carries at most this many images. */
export const MAX_IMAGES = 8;
/** The JSON body that carries one upload as base64, with room for the encoding. */
export const UPLOAD_BODY_LIMIT = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;

const ID = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export interface Upload {
  id: string;
  url: string;
  size: number;
}

/** The image type the bytes themselves show; the name or declared type is never trusted. */
export function imageExtension(bytes: Buffer): "png" | "jpg" | "gif" | "webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  return null;
}

export class Uploads {
  readonly dir: string;

  constructor(dir: string) {
    // Absolute, since the path is what an agent reads the image from.
    this.dir = resolve(dir);
  }

  /** Stores one image sent as base64 (a data: URL is fine too). */
  save(input: { data?: unknown }): Upload {
    if (typeof input.data !== "string" || !input.data) throw new InboxError(400, "send the image as base64 in data");
    const base64 = input.data.replace(/^data:[^,]*,/, "");
    if (base64.length > UPLOAD_BODY_LIMIT) throw new InboxError(413, "images are limited to 10 MB");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) throw new InboxError(400, "the image is empty");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new InboxError(413, "images are limited to 10 MB");
    const ext = imageExtension(bytes);
    if (!ext) throw new InboxError(415, "only PNG, JPEG, GIF and WebP images can be attached");
    const id = `${randomUUID()}.${ext}`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, id), bytes, { flag: "wx" });
    return { id, url: `/uploads/${id}`, size: bytes.length };
  }

  /** The stored file for an id, or null for anything that is not one. */
  path(id: string): string | null {
    if (!ID.test(id)) return null;
    const path = join(this.dir, id);
    return existsSync(path) ? path : null;
  }

  /** The ids a message or an answer names, each one checked to be a stored image. */
  check(ids: unknown): string[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new InboxError(400, "images must be a list of upload ids");
    if (ids.length > MAX_IMAGES) throw new InboxError(400, `attach at most ${MAX_IMAGES} images`);
    const out = [...new Set(ids.map(String))];
    for (const id of out) if (!this.path(id)) throw new InboxError(400, `no uploaded image ${id}`);
    return out;
  }
}
