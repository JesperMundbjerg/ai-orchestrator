// Bounded, repo-only discovery. Configuration names files; no project code is imported/run.
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { PipelineDefinition } from "../../shared/pipeline.ts";

export const BUILTINS: PipelineDefinition[] = [
  ["work", "Assigned work", "A bounded crew task; the first mate records its scoped report."],
  ["check", "Run a check", "Evidence needs the command, exit status and result. The office runs nothing."],
  ["founder-approval", "Founder approves", "An accept at the exact item revision and candidate."],
  ["condition", "Choose a branch", "The first mate selects a declared enum or boolean with a rationale."],
  ["handoff", "Hand off to a team", "Create office work in review, not a Git delivery."],
  ["review", "Accept reviewed work", "The receiving first mate's final acceptance."],
  ["deliver", "Deliver to dev", "Gate a pinned candidate before repository landing and publication."],
].map(([key, label, description]) => ({ id: `builtin:${key}`, label: label!, description: description!, kind: "builtin", path: null, hash: null }));
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function within(root: string, path: string): boolean {
  const r = relative(root, path); return !r.startsWith(`..${sep}`) && r !== ".." && !r.startsWith(sep);
}
export function discover(repoRoot: string): { entries: PipelineDefinition[]; problems: string[] } {
  const entries = [...BUILTINS]; const problems: string[] = []; const seen = new Set<string>();
  let root: string;
  try { root = realpathSync(repoRoot); } catch { return { entries, problems: ["repository is unavailable"] }; }
  const read = (file: string): { path: string; text: string } | null => {
    try {
      const path = realpathSync(file);
      if (!within(root, path)) { problems.push(`${file}: resource escapes repository`); return null; }
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 128 * 1024) { problems.push(`${file}: resource is not a bounded regular file`); return null; }
      return { path, text: readFileSync(path, "utf8") };
    } catch { return null; }
  };
  const add = (file: string, kind: "agent" | "skill" | "command") => {
    const found = read(file); if (!found || seen.has(found.path)) return;
    if (seen.size >= 250) { if (!problems.includes("resource limit reached")) problems.push("resource limit reached"); return; }
    seen.add(found.path);
    const path = relative(root, found.path).split(sep).join("/");
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(found.text)?.[1] ?? found.text;
    const field = (name: string) => new RegExp(`^${name}\\s*[:=]\\s*(.+)$`, "m").exec(header)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const fallback = kind === "skill" ? path.split("/").at(-2)! : path.split("/").at(-1)!.replace(/\.(md|toml)$/, "");
    entries.push({ id: `${kind}:${path}`, label: (field("name") ?? fallback).slice(0, 200), description: (field("description") ?? "").slice(0, 4000), kind, path, hash: digest(found.text) });
  };
  const directory = (dir: string, kind: "agent" | "skill" | "command", skills = false) => {
    let paths: string[];
    try { const canonical = realpathSync(dir); if (!within(root, canonical)) { problems.push(`${dir}: resource directory escapes repository`); return; } paths = readdirSync(canonical).sort(); }
    catch { return; }
    for (const name of paths.slice(0, 250)) {
      if (skills) add(join(dir, name, "SKILL.md"), kind);
      else if (/\.(md|toml)$/.test(name)) add(join(dir, name), kind);
    }
  };
  directory(join(root, ".claude", "agents"), "agent");
  directory(join(root, ".claude", "skills"), "skill", true);
  directory(join(root, ".claude", "commands"), "command");
  directory(join(root, ".pi", "skills"), "skill", true);
  directory(join(root, ".pi", "prompts"), "command");
  directory(join(root, ".pi", "agents"), "agent");
  directory(join(root, ".agents", "skills"), "skill", true);
  directory(join(root, ".codex", "skills"), "skill", true);
  directory(join(root, ".codex", "agents"), "agent");
  const settings = read(join(root, ".pi", "settings.json"));
  if (settings) {
    try {
      const s = JSON.parse(settings.text);
      for (const [key, kind] of [["skills", "skill"], ["prompts", "command"]] as const) for (const path of Array.isArray(s[key]) ? s[key] : []) {
        if (typeof path !== "string") continue;
        const target = resolve(dirname(settings.path), path);
        if (!within(root, target)) { problems.push(`${path}: configured resource escapes repository`); continue; }
        if (path.endsWith(".md")) add(target, kind); else directory(target, kind, kind === "skill");
      }
    } catch { problems.push(".pi/settings.json is invalid JSON"); }
  }
  const codex = read(join(root, ".codex", "config.toml"));
  if (codex) for (const match of codex.text.matchAll(/^\s*config_file\s*=\s*["']([^"']+)["']/gm)) add(resolve(dirname(codex.path), match[1]!), "agent");
  return { entries: entries.sort((a, b) => a.id.localeCompare(b.id)), problems: [...new Set(problems)].sort() };
}
