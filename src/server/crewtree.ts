// The crew tree on disk and as the leads read it. It lives in the service's data directory as a
// JSON file (so it can be edited by hand as well as in the office), seeded on first use from the
// default in the repo. It is read from disk every time, so an edit reaches running leads at their
// next `inbox crew` without restarting anyone.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelLabel } from "../shared/models.ts";
import { validateCrewTree, type CrewCatalog, type CrewChoice, type CrewRule, type CrewTree, type CrewTreeState } from "../shared/crewtree.ts";
import { InboxError } from "./inbox.ts";

const DEFAULT_FILE = fileURLToPath(new URL("./crewtree.default.json", import.meta.url));
export const PI_MODELS_STORE = join(homedir(), ".pi/agent/models-store.json");

/** The harnesses crew can run as. Anything else has no permissions set up. */
const CLAUDE_MODELS = [
  { id: "opus", label: "Opus 5.5" },
  { id: "sonnet", label: "Sonnet 5.5" },
  { id: "haiku", label: "Haiku 4.5" },
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const SAFE = /^[A-Za-z0-9._-]+$/;

/** What Pi can run, from its model store: ids and display names only, never anything else in the file. */
export function piModels(store = PI_MODELS_STORE): Array<{ id: string; label: string }> {
  try {
    const data = JSON.parse(readFileSync(store, "utf8")) as Record<string, { models?: Array<{ id?: unknown; name?: unknown }> }>;
    return Object.entries(data).flatMap(([provider, v]) =>
      (Array.isArray(v?.models) ? v.models : []).flatMap((m) =>
        typeof m?.id === "string" && SAFE.test(m.id) && SAFE.test(provider)
          ? [{ id: `${provider}/${m.id}`, label: typeof m.name === "string" && m.name ? m.name : modelLabel(m.id) }]
          : []));
  } catch {
    return [];
  }
}

export function crewCatalog(piStore = PI_MODELS_STORE): CrewCatalog {
  return {
    harnesses: [
      { id: "claude", label: "Claude Code", models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS },
      { id: "pi", label: "Pi", models: piModels(piStore), efforts: PI_EFFORTS },
    ],
  };
}

/** Only the known fields, trimmed, so a saved file holds nothing a hand edit left stray. */
function clean(tree: CrewTree): CrewTree {
  const choice = (c: CrewChoice): CrewChoice => ({ harness: c.harness, model: c.model, effort: c.effort });
  const rule = (r: CrewRule): CrewRule => ({
    id: r.id,
    when: r.when.trim(),
    ...(r.use ? { use: choice(r.use) } : {}),
    ...(r.why?.trim() ? { why: r.why.trim() } : {}),
    ...(r.children?.length ? { children: r.children.map(rule) } : {}),
  });
  return { version: 1, rules: tree.rules.map(rule), fallback: { ...choice(tree.fallback), ...(tree.fallback.why?.trim() ? { why: tree.fallback.why.trim() } : {}) } };
}

export class CrewTreeStore {
  readonly file: string;
  private piStore: string;

  constructor(dir: string, opts: { piStore?: string } = {}) {
    this.file = join(dir, "crew-tree.json");
    this.piStore = opts.piStore ?? PI_MODELS_STORE;
  }

  catalog(): CrewCatalog {
    return crewCatalog(this.piStore);
  }

  private defaults(): CrewTree {
    return JSON.parse(readFileSync(DEFAULT_FILE, "utf8")) as CrewTree;
  }

  /** The default is written once, the first time, and never over a file that exists. */
  seed(): void {
    if (existsSync(this.file)) return;
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      writeFileSync(this.file, `${JSON.stringify(this.defaults(), null, 2)}\n`, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  /** The tree as it is on disk now. A file that is unreadable or invalid is said so, and the default stands in for it. */
  state(): CrewTreeState {
    this.seed();
    const catalog = this.catalog();
    let problem: string;
    try {
      const tree = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      const problems = validateCrewTree(tree, catalog);
      if (!problems.length) return { tree: clean(tree as CrewTree), catalog, file: this.file, problem: null };
      problem = problems.map((p) => `${p.path}: ${p.message}`).join("; ");
    } catch (err) {
      problem = `not valid JSON (${(err as Error).message})`;
    }
    return { tree: this.defaults(), catalog, file: this.file, problem: `${this.file} cannot be used, so the default tree stands in for it: ${problem}` };
  }

  save(input: unknown): CrewTreeState {
    const problems = validateCrewTree(input, this.catalog());
    if (problems.length) throw new InboxError(422, `The crew tree was not saved: ${problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(clean(input as CrewTree), null, 2)}\n`);
    renameSync(temp, this.file);
    return this.state();
  }

  /** What a lead reads: the tree, compact, each choice with the command that starts it. */
  text(): string {
    const { tree, catalog, problem } = this.state();
    return crewText(tree, catalog, problem);
  }
}

/** The words after `--` on `herdr agent start`: the harness's own flags for this model and effort. */
function startArgs(c: CrewChoice): string {
  return c.harness === "pi" ? `--model ${c.model}:${c.effort}` : `--model ${c.model} --effort ${c.effort}`;
}

export const startCommand = (c: CrewChoice): string => `herdr agent start <name> --kind ${c.harness} --pane "$P" -- ${startArgs(c)}`;

export function crewText(tree: CrewTree, catalog: CrewCatalog, problem: string | null = null): string {
  const describe = (c: CrewChoice) => {
    const h = catalog.harnesses.find((x) => x.id === c.harness);
    const label = h?.models.find((m) => m.id === c.model)?.label ?? modelLabel(c.model);
    return `${label}, ${c.effort} effort, in ${h?.label ?? c.harness}`;
  };
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = [
    "Crew guide (the founder's decision tree; they edit it, so read it again before each crew member): take the first rule whose \"when\" fits the task. A rule with sub-rules is a question that narrows further; its own choice applies when none of its sub-rules fits. Start the member with the command shown, with `P=$(inbox pane)` and a unique lowercase <name>. Never any other harness or model.",
  ];
  if (problem) lines.push(`Note: ${problem}`);
  const walk = (rules: CrewRule[], prefix: string, indent: string) =>
    rules.forEach((r, i) => {
      const n = `${prefix}${i + 1}`;
      lines.push(`${indent}${n}. When: ${one(r.when)}`);
      if (r.use) {
        lines.push(`${indent}   Use: ${describe(r.use)}${r.why ? `. ${one(r.why)}` : ""}`);
        lines.push(`${indent}   Start: ${startCommand(r.use)}`);
      }
      if (r.children?.length) {
        lines.push(`${indent}   ${r.use ? "Sub-rules, checked first; the choice above applies when none fits:" : "Sub-rules, to narrow further:"}`);
        walk(r.children, `${n}.`, `${indent}   `);
      }
    });
  walk(tree.rules, "", "");
  lines.push(`Otherwise: ${describe(tree.fallback)}${tree.fallback.why ? `. ${one(tree.fallback.why)}` : ""}`, `   Start: ${startCommand(tree.fallback)}`);
  return lines.join("\n");
}
