// A project's lane routing, overridden by the office. A project that opts in names, in its tracked
// `orchestrator.json`, an untracked override file ("laneRouting": {"override": "<path>"}, where the
// path may start with <git-common-dir>); the office is that file's only writer. The file has the
// shape of the project's tracked routing (FysikLab's .pi/fysiklab.json): top-level runtimes, lanes,
// agents and nativeClaude, where a key in the override wins and an absent key means the tracked
// default. The office writes only the keys it changes, keeps every other key, and replaces the
// file atomically (a temporary file renamed in the same directory). Without the declaration it
// writes nothing.
//
// Two things write: the founder switching a standing lane's agent to another harness (switch.ts),
// and the office's Pi pause turning on or off. A pause records in the database what it changed
// before it changes it, so a restart mid-pause still lifts it; lifting puts back each key's earlier
// override value, or deletes the key when it had none, and leaves a lane alone whose keys no longer
// say what the pause wrote (the founder switched it by hand). A write only affects a lane's next
// start: no session is restarted, and the founder is told in the office which lanes changed.
// An override that exists but cannot be read is never overwritten: the write is refused and said.

import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AdapterLane, Harness, Repository, WorldState } from "../shared/types.ts";
import { MIXED, type CrewTree } from "../shared/crewtree.ts";
import type { CrewPause } from "./crewtree.ts";
import { ADAPTER_FILE } from "./adapter.ts";
import { laneAgent, type LaneRegistration } from "./queue.ts";
import { switchChoice } from "./switch.ts";

export const COMMON_DIR = "<git-common-dir>";
/** The two keys a lane's runtime is written in, always together. */
const SECTIONS = ["runtimes", "lanes"] as const;
type Section = (typeof SECTIONS)[number];
type Json = Record<string, unknown>;
type Row = Record<string, unknown>;

/** Where a project keeps its routing: the override the office writes, and the tracked default when the project names it. */
export interface RoutingFiles {
  project: string;
  root: string;
  override: string;
  tracked: string | null;
}

/** A routing the office cannot use: said to the founder, never guessed past. */
class Unusable extends Error {}

/**
 * The project's declaration, read from its tracked orchestrator.json: null when it declares none.
 * `override` may start with <git-common-dir> (git's common directory of the main checkout); any
 * other relative path is from the main checkout. The override must stay inside the main checkout
 * or git's common directory. `tracked`, optional, names the tracked default the same way.
 */
export function routingFiles(root: string, project: string, gitCommonDir: (root: string) => string = commonDir): RoutingFiles | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, ADAPTER_FILE), "utf8"));
  } catch {
    return null;
  }
  const decl = (raw as Json | null)?.laneRouting;
  if (decl === undefined) return null;
  const d = decl as Json | null;
  if (!d || typeof d !== "object" || Array.isArray(d) || typeof d.override !== "string" || !d.override.trim()) {
    throw new Unusable(`${ADAPTER_FILE}'s laneRouting must be {"override": "<path>"}`);
  }
  if (d.tracked !== undefined && (typeof d.tracked !== "string" || !d.tracked.trim())) throw new Unusable(`${ADAPTER_FILE}'s laneRouting.tracked must be a path`);
  let common: string | null = null;
  const place = (path: string): string => {
    const p = path.trim();
    if (p === COMMON_DIR || p.startsWith(`${COMMON_DIR}/`)) {
      common ??= gitCommonDir(root);
      return resolve(common, p.slice(COMMON_DIR.length + 1));
    }
    return isAbsolute(p) ? resolve(p) : resolve(root, p);
  };
  const override = place(d.override);
  common ??= gitCommonDir(root);
  if (!within(root, override) && !within(common, override)) throw new Unusable(`laneRouting.override (${override}) is outside the main checkout and git's common directory`);
  return { project, root, override, tracked: typeof d.tracked === "string" ? place(d.tracked) : null };
}

const within = (dir: string, path: string) => { const r = relative(dir, path); return !!r && !r.startsWith("..") && !isAbsolute(r); };

function commonDir(root: string): string {
  try {
    return resolve(root, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch (err) {
    throw new Unusable(`git could not name the common directory of ${root}: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** The override as it is: a missing file is an empty override; one that exists but is not a JSON object is refused. */
export function readOverride(file: string): Json {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Unusable(`the override ${file} could not be read (${(err as Error).message}), so it was not changed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Unusable(`the override ${file} is not valid JSON, so it was not changed; fix or remove it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Unusable(`the override ${file} is not a JSON object, so it was not changed; fix or remove it`);
  for (const s of SECTIONS) {
    const v = (parsed as Json)[s];
    if (v !== undefined && (!v || typeof v !== "object" || Array.isArray(v))) throw new Unusable(`the override ${file} has a "${s}" that is not an object, so it was not changed; fix or remove it`);
  }
  return parsed as Json;
}

/** Replaces the file in one step: a temporary file beside it, renamed over it. */
export function writeOverride(file: string, value: Json): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** The tracked default as the project reads it (a file it cannot read is an empty routing). */
function readTracked(file: string | null): Json {
  if (!file) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

const section = (routing: Json, s: Section): Json => {
  const v = routing[s];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
};

/** One key of a lane: the override's when it has it, else the tracked default's (FysikLab's readRouting merged per key). */
const effective = (override: Json, tracked: Json, s: Section, lane: string): unknown =>
  Object.hasOwn(section(override, s), lane) ? section(override, s)[lane] : section(tracked, s)[lane];

/** The lane's runtime as the project decides it: its runtime, else Pi when it is routed to a provider/model. */
function runtimeOf(override: Json, tracked: Json, lane: string): string {
  const runtime = effective(override, tracked, "runtimes", lane);
  if (typeof runtime === "string") return runtime;
  const spec = effective(override, tracked, "lanes", lane);
  return typeof spec === "string" && /^[^/]+\/.+/.test(spec) ? "pi" : "claude";
}

/** The two values a lane is written as on `to`: Pi takes "<provider>/<model>", Claude Code "claude-code/<model>". */
export function laneValues(to: Harness, model: string): Record<Section, string> | null {
  if (to === "claude") return { runtimes: "claude", lanes: `claude-code/${model.replace(/^(?:claude-code|anthropic)\//, "")}` };
  if (to === "pi" && /^[^/]+\/.+/.test(model)) return { runtimes: "pi", lanes: model };
  return null;
}

/**
 * Whether the office pauses Pi now, as the crew guide applies it: a pause of Pi that is not
 * running on credits, under the founder's Mix. On a one-harness setting a pause changes nothing.
 */
export function piPaused(mode: string | undefined, pause: CrewPause | null): boolean {
  return mode === MIXED && pause?.harness === "pi" && !pause.onCredits;
}

export interface LaneRoutingOpts {
  /** Tells the founder in the office: a title, the text, and the agents it is about. */
  notice: (title: string, body: string, agentIds: string[]) => void;
  /** The founder's crew tree, for the model a lane takes during a pause. */
  tree?: () => CrewTree | null;
  registered?: LaneRegistration;
  gitCommonDir?: (root: string) => string;
  now?: () => Date;
}

export class LaneRouting {
  private db: DatabaseSync;
  private opts: LaneRoutingOpts;
  private now: () => Date;
  /** Problems already said, so a refusal the 30 s tick meets again is said once. */
  private told = new Set<string>();

  constructor(db: DatabaseSync, opts: LaneRoutingOpts) {
    this.db = db;
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * The founder switched `agentId` to another harness: each declaring project's lane it stands
   * behind starts on `to` and `model` next time. Its runtimes and lanes keys are written together;
   * a pause's record of the lane is dropped, so lifting the pause keeps the founder's choice.
   * A lane already routed there is written all the same: the founder is told what it starts on.
   */
  switched(state: WorldState, agentId: string, to: Harness, model: string): void {
    for (const { repo, files, lane } of this.lanesOf(state, agentId)) {
      const values = laneValues(to, model);
      if (!values) {
        this.say(`${files.override}:model`, "Lane routing not written", `${files.project}'s ${lane.name} lane was switched to ${to} with model "${model}", which names no provider, so its routing in ${files.override} was left as it was.`, [agentId]);
        continue;
      }
      try {
        const current = readOverride(files.override);
        const next = structuredClone(current);
        for (const s of SECTIONS) next[s] = { ...section(current, s), [lane.name]: values[s] };
        writeOverride(files.override, next);
        // The founder's choice outlasts a pause: lifting it no longer touches this lane.
        this.db.prepare("DELETE FROM lane_routing_paused WHERE override = ? AND lane = ?").run(files.override, lane.name);
        this.told.delete(`${files.override}:read`);
        this.opts.notice("Lane routing changed", `${files.project}'s ${lane.name} lane will start on ${values.runtimes === "pi" ? "Pi" : "Claude Code"} (${values.lanes}) from now on: the office wrote it to ${files.override}. Its running session is not restarted; the lane picks this up at its next start.`, [agentId]);
      } catch (err) {
        this.refuse(files, err, [agentId]);
      }
    }
  }

  /**
   * Applies or lifts the Pi pause on every project that declares an override. Applying records,
   * before writing, each key it changes and its earlier override value; lifting reads that record,
   * so it works across a restart. Projects whose declaration cannot be read are said and skipped.
   */
  sync(state: WorldState, paused: boolean): void {
    for (const repo of state.repositories) {
      if (!repo.adapter) continue;
      let files: RoutingFiles | null;
      try {
        files = routingFiles(repo.root, repo.adapter.project, this.opts.gitCommonDir);
      } catch (err) {
        this.say(`${repo.root}:declaration`, "Lane routing not written", `${repo.adapter.project}: ${(err as Error).message}.`, []);
        continue;
      }
      if (!files) continue;
      const episode = this.db.prepare("SELECT 1 FROM lane_routing_pauses WHERE override = ?").get(files.override);
      try {
        if (paused && !episode) this.pause(repo, files, state);
        else if (!paused && episode) this.lift(files, state, repo);
      } catch (err) {
        this.refuse(files, err, []);
      }
    }
  }

  /** Every lane the project routes to Pi starts on Claude Code: the Claude half of its crew-guide pair. */
  private pause(repo: Repository, files: RoutingFiles, state: WorldState): void {
    const current = readOverride(files.override);
    const tracked = readTracked(files.tracked);
    const names = new Set<string>([...(repo.adapter?.lanes ?? []).map((l) => l.name), ...SECTIONS.flatMap((s) => [...Object.keys(section(tracked, s)), ...Object.keys(section(current, s))])]);
    names.delete("*");
    const next = structuredClone(current);
    const changed: Array<{ lane: string; values: Record<Section, string> }> = [];
    for (const lane of [...names].sort()) {
      if (runtimeOf(current, tracked, lane) !== "pi") continue;
      const spec = effective(current, tracked, "lanes", lane);
      const role = repo.adapter?.lanes.find((l) => l.name === lane)?.role;
      const choice = switchChoice(this.opts.tree?.() ?? null, { harness: "pi", model: typeof spec === "string" ? spec : null, lead: role === "router" }, "claude");
      const values = laneValues("claude", choice.model)!;
      for (const s of SECTIONS) next[s] = { ...section(next, s), [lane]: values[s] };
      changed.push({ lane, values });
    }
    const at = this.now().toISOString();
    // What the pause changes is committed before the file is written: a crash between the two
    // leaves a record whose values the file does not show, which lifting leaves alone.
    this.tx(() => {
      this.db.prepare("INSERT INTO lane_routing_pauses (override, project, started_at) VALUES (?, ?, ?)").run(files.override, files.project, at);
      const add = this.db.prepare("INSERT INTO lane_routing_paused (override, section, lane, previous, written) VALUES (?, ?, ?, ?, ?)");
      for (const { lane, values } of changed) {
        for (const s of SECTIONS) {
          const had = Object.hasOwn(section(current, s), lane);
          add.run(files.override, s, lane, had ? JSON.stringify(section(current, s)[lane]) : null, JSON.stringify(values[s]));
        }
      }
    });
    if (changed.length) {
      try {
        writeOverride(files.override, next);
      } catch (err) {
        this.forget(files.override);
        throw err;
      }
    }
    this.told.delete(`${files.override}:read`);
    if (!changed.length) return;
    this.opts.notice("Pi paused for standing lanes", `Pi is paused, so the office routed ${files.project}'s ${list(changed.map((c) => `${c.lane} (${c.values.lanes})`))} to Claude Code in ${files.override}. Running sessions are not restarted; each lane picks this up at its next start, and goes back to its earlier routing when the pause lifts.`, this.agentIds(state, repo, changed.map((c) => c.lane)));
  }

  /** Each lane whose keys still say what the pause wrote gets its earlier values back; any other lane keeps what it says now. */
  private lift(files: RoutingFiles, state: WorldState, repo: Repository): void {
    const rows = this.db.prepare("SELECT * FROM lane_routing_paused WHERE override = ? ORDER BY lane, section").all(files.override) as Row[];
    const current = readOverride(files.override);
    const next = structuredClone(current);
    const restored: string[] = [];
    const kept: string[] = [];
    for (const lane of [...new Set(rows.map((r) => String(r.lane)))]) {
      const mine = rows.filter((r) => r.lane === lane);
      const untouched = mine.every((r) => {
        const s = String(r.section) as Section;
        return Object.hasOwn(section(current, s), lane) && JSON.stringify(section(current, s)[lane]) === String(r.written);
      });
      if (!untouched) { kept.push(lane); continue; }
      for (const r of mine) {
        const s = String(r.section) as Section;
        const values = { ...section(next, s) };
        if (r.previous === null) delete values[lane];
        else values[lane] = JSON.parse(String(r.previous));
        if (Object.keys(values).length) next[s] = values;
        else delete next[s];
      }
      restored.push(lane);
    }
    // The file first: a crash before the record is dropped leaves lanes that no longer say what
    // the pause wrote, which the next lift keeps as they are.
    if (restored.length) writeOverride(files.override, next);
    this.forget(files.override);
    this.told.delete(`${files.override}:read`);
    if (!restored.length && !kept.length) return;
    this.opts.notice("Pi pause lifted for standing lanes", [
      restored.length ? `Pi is no longer paused, so ${files.project}'s ${list(restored)} ${restored.length === 1 ? "is" : "are"} routed as before the pause again in ${files.override}; each lane picks this up at its next start, and running sessions are not restarted.` : `Pi is no longer paused.`,
      kept.length ? `${list(kept)} ${kept.length === 1 ? "was" : "were"} changed during the pause, so ${kept.length === 1 ? "it keeps" : "they keep"} what ${kept.length === 1 ? "it says" : "they say"} now.` : "",
    ].filter(Boolean).join(" "), this.agentIds(state, repo, restored));
  }

  /** The declaring projects' lanes `agentId` stands behind. */
  private lanesOf(state: WorldState, agentId: string): Array<{ repo: Repository; files: RoutingFiles; lane: AdapterLane }> {
    return state.repositories.flatMap((repo) => {
      const lanes = (repo.adapter?.lanes ?? []).filter((lane) => laneAgent(lane, state.agents, this.opts.registered?.(repo.root, lane, state) ?? null)?.id === agentId);
      if (!lanes.length) return [];
      let files: RoutingFiles | null;
      try {
        files = routingFiles(repo.root, repo.adapter!.project, this.opts.gitCommonDir);
      } catch (err) {
        this.say(`${repo.root}:declaration`, "Lane routing not written", `${repo.adapter!.project}: ${(err as Error).message}.`, [agentId]);
        return [];
      }
      return files ? lanes.map((lane) => ({ repo, files: files!, lane })) : [];
    });
  }

  /** Drops a pause's record of one override. */
  private forget(override: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM lane_routing_paused WHERE override = ?").run(override);
      this.db.prepare("DELETE FROM lane_routing_pauses WHERE override = ?").run(override);
    });
  }

  private agentIds(state: WorldState, repo: Repository, lanes: string[]): string[] {
    return (repo.adapter?.lanes ?? []).filter((l) => lanes.includes(l.name)).flatMap((l) => {
      const a = laneAgent(l, state.agents, this.opts.registered?.(repo.root, l, state) ?? null);
      return a ? [a.id] : [];
    });
  }

  private refuse(files: RoutingFiles, err: unknown, agentIds: string[]): void {
    if (!(err instanceof Unusable)) {
      this.say(`${files.override}:write:${(err as Error).message}`, "Lane routing not written", `The office could not write ${files.project}'s lane routing to ${files.override}: ${(err as Error).message}. Nothing was changed.`, agentIds);
      return;
    }
    this.say(`${files.override}:read`, "Lane routing not written", `${files.project}: ${err.message}.`, agentIds);
  }

  private say(key: string, title: string, body: string, agentIds: string[]): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.opts.notice(title, body, agentIds);
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
