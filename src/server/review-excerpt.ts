// The projector never reads arbitrary paths or tool output. Only small source files in the
// reporting agent's checkout, with dot/private files and suspicious content withheld entirely.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ReviewExcerpt } from "../shared/types.ts";

const SOURCE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".py", ".rs", ".go", ".sql"]);
const privatePath = (p: string) => p.split(/[\\/]/).some((s) => s.startsWith(".") || /(?:secret|credential|password|token|private[-_]?key|^id_rsa$)/i.test(s));
const inside = (root: string, file: string) => { const p = relative(root, file); return p !== "" && p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p); };

/** windowSeed selects a full twelve-line window only after the same whole-file safety checks. */
export function reviewExcerpt(cwd: string | null, path: string, offset: unknown = 1, windowSeed?: number): ReviewExcerpt | null {
  if (!cwd || !path || privatePath(path)) return null;
  let fd: number | undefined;
  try {
    const root = realpathSync(cwd);
    const candidate = resolve(cwd, path);
    if (!inside(resolve(cwd), candidate) && !inside(root, candidate)) return null;
    const file = realpathSync(candidate);
    const local = relative(root, file);
    if (!inside(root, file) || privatePath(local) || !SOURCE.has(extname(file).toLowerCase())) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024) return null;
    const text = readFileSync(fd, "utf8");
    // Fail closed for key material, credential-bearing code and long opaque values. Do not
    // send even the filename when a file was withheld. This is deliberately conservative.
    if (/[\x00-\x08\x0e-\x1f]|PRIVATE KEY|password|secret|token|api[_-]?key|authorization|Bearer\s+\S+|AKIA[0-9A-Z]{16}|[A-Za-z0-9_+\/-]{40,}/i.test(text)) return null;
    const lines = text.split(/\r?\n/);
    let startLine = windowSeed !== undefined && Number.isFinite(windowSeed)
      ? 1 + (Math.abs(Math.floor(windowSeed)) % Math.max(1, lines.length - 11))
      : typeof offset === "number" && Number.isFinite(offset) ? Math.max(1, Math.min(lines.length, Math.floor(offset))) : 1;
    if (windowSeed !== undefined && !lines.slice(startLine - 1, startLine + 11).some((s) => s.trim())) {
      const firstCode = lines.findIndex((s) => s.trim());
      if (firstCode < 0) return null;
      startLine = Math.min(firstCode + 1, Math.max(1, lines.length - 11));
    }
    return { path: local.split(sep).join("/"), startLine, lines: lines.slice(startLine - 1, startLine + 11).map((s) => s.slice(0, 100)) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
