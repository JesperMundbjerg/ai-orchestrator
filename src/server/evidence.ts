// Stream only an attachment already resolved by Inbox.evidenceFile. No client paths here.
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** One byte range. Unsupported/malformed ranges are ignored; unsatisfiable ones get 416. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (!size || (first !== null && first >= size) || (first === null && !last) || (first !== null && last !== null && last < first)) return "unsatisfiable";
  return {
    start: first ?? Math.max(0, size - last!),
    end: first === null ? size - 1 : Math.min(last ?? size - 1, size - 1),
  };
}

export function sendEvidence(req: IncomingMessage, res: ServerResponse, path: string, contentType: string): void {
  const size = statSync(path).size;
  const headers = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  };
  // With no validators of our own, an If-Range cannot match: return the full representation.
  const range = req.method === "HEAD" || req.headers["if-range"] ? null : byteRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
    res.end();
    return;
  }
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "content-length": range ? range.end - range.start + 1 : size,
    ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}),
  });
  if (req.method === "HEAD") { res.end(); return; }
  const stream = createReadStream(path, range ?? undefined);
  stream.on("error", (error) => res.destroy(error));
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
