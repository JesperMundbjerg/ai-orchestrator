// A project's own description of itself: `orchestrator.json` in its main checkout names its
// checks, reviewers, landing rules, where its pages are served and its standing lanes. The service
// reads it and runs nothing from it but a lane's own `attach` argv (standing.ts). A missing file
// is fine; an invalid one is reported rather than half-used, and the file is read again whenever it changes.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { HARNESSES, type AdapterLane, type Harness, type ProjectAdapter } from "../shared/types.ts";
import { projectSlug } from "../shared/slug.ts";
import { validateGraph } from "./pipelines/model.ts";

export const ADAPTER_FILE = "orchestrator.json";

const KNOWN = ["project", "integrationBranch", "preview", "comments", "decisions", "checks", "reviewers", "land", "lanes", "pipeline"];

type Json = Record<string, unknown>;

/** Collects what is wrong, so one read reports every problem at once. */
class Check {
  errors: string[] = [];
  private isObject(v: unknown): v is Json {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  object(v: unknown, at: string): Json | null {
    if (v === undefined || v === null) return null;
    if (this.isObject(v)) return v;
    this.errors.push(`${at} must be an object`);
    return null;
  }
  string(v: unknown, at: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v === "string" && v.trim()) return v.trim();
    this.errors.push(`${at} must be a non-empty string`);
    return null;
  }
  count(v: unknown, at: string): number | null {
    if (v === undefined || v === null) return null;
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
    this.errors.push(`${at} must be a whole number above 0`);
    return null;
  }
  strings(v: unknown, at: string): string[] {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim())) return v.map((x: string) => x.trim());
    this.errors.push(`${at} must be a list of strings`);
    return [];
  }
}

/** A lane's attach command: argv, never a shell line, so the office runs exactly what is written. */
function attachArgv(c: Check, v: unknown, at: string): string[] | null {
  if (v === undefined || v === null) return null;
  const argv = c.strings(v, at);
  if (Array.isArray(v) && !v.length) c.errors.push(`${at} must name a command`);
  return argv.length ? argv : null;
}

/**
 * Reads the file's text for the repository at `repoRoot`. Returns the adapter, or null with the
 * reasons when it cannot be used; keys it does not know are reported but do not stop it.
 */
export function parseAdapter(text: string, repoRoot: string, repoName: string): { adapter: ProjectAdapter | null; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { adapter: null, problems: [`${ADAPTER_FILE} is not valid JSON: ${(err as Error).message}`] };
  }
  const c = new Check();
  const top = c.object(raw, ADAPTER_FILE);
  if (!top) return { adapter: null, problems: c.errors.length ? c.errors : [`${ADAPTER_FILE} is empty`] };
  const ignored = Object.keys(top).filter((k) => !KNOWN.includes(k)).map((k) => `${ADAPTER_FILE}: unknown key "${k}" ignored`);

  const project = c.string(top.project, "project") ?? (projectSlug(repoName) || repoName);
  if (!projectSlug(project) || projectSlug(project) !== project) c.errors.push(`project must be lowercase letters, digits and dashes (it goes in URLs): "${project}"`);

  const preview = c.object(top.preview, "preview");
  const base = preview ? c.string(preview.base, "preview.base") : null;
  if (base && !/^https?:\/\/[^/]+/.test(base)) c.errors.push(`preview.base must be an http(s) address: "${base}"`);

  const comments = c.object(top.comments, "comments");
  const decisions = c.object(top.decisions, "decisions");
  const reviewers = c.object(top.reviewers, "reviewers");
  const land = c.object(top.land, "land");

  const checks: Record<string, string> = {};
  for (const [tier, command] of Object.entries(c.object(top.checks, "checks") ?? {})) {
    const value = c.string(command, `checks.${tier}`);
    if (value) checks[tier] = value;
  }

  const lanes: AdapterLane[] = [];
  if (top.lanes !== undefined && !Array.isArray(top.lanes)) c.errors.push("lanes must be a list");
  for (const [i, entry] of (Array.isArray(top.lanes) ? top.lanes : []).entries()) {
    const lane = c.object(entry, `lanes[${i}]`);
    if (!lane) continue;
    const name = c.string(lane.name, `lanes[${i}].name`);
    if (!name) {
      if (lane.name === undefined) c.errors.push(`lanes[${i}] needs a name`);
      continue;
    }
    if (lanes.some((l) => l.name.toLowerCase() === name.toLowerCase())) c.errors.push(`lanes: "${name}" is named twice`);
    const worktree = c.string(lane.worktree, `lanes[${i}].worktree`);
    const harness = c.string(lane.harness, `lanes[${i}].harness`);
    if (harness && !HARNESSES.includes(harness as Harness)) c.errors.push(`lanes[${i}].harness must be one of ${HARNESSES.join(", ")}`);
    lanes.push({
      name,
      worktree: worktree ? (isAbsolute(worktree) ? worktree : resolve(repoRoot, worktree)) : null,
      agent: c.string(lane.agent, `lanes[${i}].agent`),
      harness: harness as Harness | null,
      model: c.string(lane.model, `lanes[${i}].model`),
      role: c.string(lane.role, `lanes[${i}].role`),
      attach: attachArgv(c, lane.attach, `lanes[${i}].attach`),
    });
  }

  let pipeline;
  if (top.pipeline !== undefined && top.pipeline !== null) {
    try { pipeline = validateGraph(top.pipeline); }
    catch (err) { c.errors.push(err instanceof Error ? err.message : "invalid pipeline"); }
  }
  const adapter: ProjectAdapter = {
    project,
    integrationBranch: c.string(top.integrationBranch, "integrationBranch"),
    preview: base ? { base } : null,
    comments: comments && {
      kinds: c.strings(comments.kinds, "comments.kinds"),
      anchor: c.strings(comments.anchor, "comments.anchor"),
      charter: c.string(comments.charter, "comments.charter"),
      leaseMinutes: c.count(comments.leaseMinutes, "comments.leaseMinutes"),
    },
    decisions: decisions && { maxQuestion: c.count(decisions.maxQuestion, "decisions.maxQuestion") },
    checks,
    reviewers: reviewers && { perSlice: c.strings(reviewers.perSlice, "reviewers.perSlice"), cap: c.string(reviewers.cap, "reviewers.cap") },
    land: land && { mode: c.string(land.mode, "land.mode"), publish: c.string(land.publish, "land.publish"), setup: c.string(land.setup, "land.setup") },
    lanes,
    ...(top.pipeline !== undefined ? { pipeline: pipeline ?? null } : {}),
  };
  if (c.errors.length) return { adapter: null, problems: c.errors.map((e) => `${ADAPTER_FILE}: ${e}`) };
  return { adapter, problems: ignored };
}

/** Each repository's adapter, read again when its file changes (checked on every read, which is one stat). */
export class Adapters {
  private cache = new Map<string, { stamp: string; adapter: ProjectAdapter | null; problems: string[] }>();

  read(repoRoot: string, repoName: string): { adapter: ProjectAdapter | null; problems: string[] } {
    const file = join(repoRoot, ADAPTER_FILE);
    let stamp = "";
    try {
      const s = statSync(file);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      this.cache.delete(repoRoot);
      return { adapter: null, problems: [] };
    }
    const known = this.cache.get(repoRoot);
    if (known?.stamp === stamp) return known;
    let read: { adapter: ProjectAdapter | null; problems: string[] };
    try {
      read = parseAdapter(readFileSync(file, "utf8"), repoRoot, repoName);
    } catch (err) {
      read = { adapter: null, problems: [`${ADAPTER_FILE} could not be read: ${(err as Error).message}`] };
    }
    this.cache.set(repoRoot, { stamp, ...read });
    return read;
  }
}
