// The crew tree on disk and as the leads read it. It lives in the service's data directory as a
// JSON file (so it can be edited by hand as well as in the office), seeded on first use from the
// default in the repo. It is read from disk every time, so an edit reaches running leads at their
// next `inbox crew` without restarting anyone.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelLabel } from "../shared/models.ts";
import { BUILTIN_PRESETS, MIXED, effectiveChoice, effectiveLead, upgradeCrewGuide, validateCrewGuide, validateCrewTree, type CrewGuideDocument, type CrewCatalog, type CrewChoice, type CrewRule, type CrewTree, type CrewTreeState, type CrewTreeUpdate } from "../shared/crewtree.ts";
import { InboxError } from "./inbox.ts";

const DEFAULT_FILE = fileURLToPath(new URL("./crewtree.default.json", import.meta.url));
export const PI_MODELS_STORE = join(homedir(), ".pi/agent/models-store.json");

/** The harnesses crew can run as. Anything else has no permissions set up. */
const CLAUDE_MODELS = [
  { id: "opus", label: "Opus 5.5" },
  { id: "sonnet", label: "Sonnet 5.5" },
  { id: "haiku", label: "Haiku 4.5" },
  { id: "fable", label: "Fable 5.1" },
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
    ...(r.use ? { use: choice(r.use), backup: choice(r.backup!) } : {}),
    ...(r.why?.trim() ? { why: r.why.trim() } : {}),
    ...(r.children?.length ? { children: r.children.map(rule) } : {}),
  });
  const why = (w?: string) => (w?.trim() ? { why: w.trim() } : {});
  return {
    version: 1,
    mode: tree.mode,
    rules: tree.rules.map(rule),
    fallback: { ...choice(tree.fallback), backup: choice(tree.fallback.backup), ...why(tree.fallback.why) },
    lead: { use: choice(tree.lead.use), backup: choice(tree.lead.backup), ...why(tree.lead.why) },
  };
}

/** Built-ins are recreated from the shipped Balanced tree, never from a user's mutable copy. */
export function builtinCrewTrees(): Record<string, CrewTree> {
  const balanced = JSON.parse(readFileSync(DEFAULT_FILE, "utf8")) as CrewTree;
  const top = structuredClone(balanced);
  const opus: CrewChoice = { harness: "claude", model: "opus", effort: "medium" };
  const astra: CrewChoice = { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "high" };
  const sonnet: CrewChoice = { harness: "claude", model: "sonnet", effort: "high" };
  const sol: CrewChoice = { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" };
  top.rules = top.rules.map((r) => ({ ...r,
    use: r.id === "deep-thinking" ? opus : astra,
    backup: r.id === "deep-thinking" ? astra : opus,
    why: r.id === "deep-thinking" ? "Opus for architecture and open-ended planning." : "Astra for implementation and independent code review.",
  }));
  top.fallback = { ...astra, backup: opus, why: "Astra builds; Opus is the alternate perspective." };
  const thrifty = structuredClone(balanced);
  thrifty.lead = { use: sonnet, backup: sol, why: "Sonnet plans and supervises without the top-model cost." };
  thrifty.rules = [{
    id: "mechanical", when: "Mechanical work with a clear recipe: repetitive edits, formatting, renaming, or straightforward test fixtures.",
    use: { harness: "pi", model: "openai-codex/gpt-6-luna", effort: "high" }, backup: sonnet,
    why: "Luna at high effort for bounded work; escalate ambiguous tasks to the next rule.",
  }, ...thrifty.rules.map((r) => ({ ...r, use: r.id === "deep-thinking" ? sonnet : sol,
    backup: r.id === "deep-thinking" ? sol : sonnet,
    why: "Sonnet and Sol handle work that needs judgement without top-model cost.",
  }))];
  thrifty.fallback = { ...sol, backup: sonnet, why: "Sol for everyday work, Sonnet as backup." };
  const single = (harness: string): CrewTree => {
    const t = structuredClone(balanced);
    const pair = (use: CrewChoice, backup: CrewChoice) => use.harness === harness ? { use, backup } : { use: backup, backup: use };
    t.rules = t.rules.map((r) => ({ ...r, ...pair(r.use!, r.backup!), why: `Main choice stays in ${harness === "pi" ? "Pi" : "Claude Code"}; the founder's switch can still select its backup.` }));
    t.lead = { ...pair(t.lead.use, t.lead.backup), why: "The lead uses the same harness as the crew." };
    const fb = pair(t.fallback, t.fallback.backup);
    t.fallback = { ...fb.use, backup: fb.backup, why: "The everyday choice on this harness." };
    return clean(t);
  };
  return { balanced, "top-models": clean(top), thrifty: clean(thrifty), "codex-only": single("pi"), "claude-only": single("claude") };
}

/** Why the office has paused a harness for now: the founder's rule near a usage limit. */
export interface CrewPause {
  harness: string;
  /** "the founder's 5-hour Claude use is 92%, until 17:40" */
  why: string;
  /** The harness's limit is reached but it runs on the founder's credits: nothing is paused, the guide only says why. */
  onCredits?: boolean;
}

/**
 * The switch as the guide applies it now: under Mix, a harness the office has paused gives way to
 * the other, as if the founder had switched it off. The founder's own setting is never changed, and
 * on a one-harness setting the pause changes nothing.
 */
export function pausedMode(tree: CrewTree, catalog: CrewCatalog, pause: CrewPause | null): string {
  if (tree.mode !== MIXED || !pause || pause.onCredits) return tree.mode;
  return catalog.harnesses.find((h) => h.id !== pause.harness)?.id ?? tree.mode;
}

export class CrewTreeStore {
  readonly file: string;
  private piStore: string;
  /** A harness the office pauses for now (the service sets it from the usage meters). */
  pause: () => CrewPause | null = () => null;

  constructor(dir: string, opts: { piStore?: string } = {}) {
    this.file = join(dir, "crew-tree.json");
    this.piStore = opts.piStore ?? PI_MODELS_STORE;
  }

  catalog(): CrewCatalog {
    return crewCatalog(this.piStore);
  }

  private defaults(): CrewGuideDocument {
    return { version: 2, mode: MIXED, activePreset: "balanced", copies: [{ id: "my-guide", name: "My guide", tree: builtinCrewTrees().balanced! }] };
  }

  private readDocument(): CrewGuideDocument {
    this.seed();
    const document = upgradeCrewGuide(JSON.parse(readFileSync(this.file, "utf8")));
    const problems = validateCrewGuide(document, this.catalog());
    if (problems.length) throw new Error(problems.map((p) => `${p.path}: ${p.message}`).join("; "));
    return document as CrewGuideDocument;
  }

  private present(document: CrewGuideDocument, problem: string | null): CrewTreeState {
    const presets = [
      ...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })),
      ...document.copies.map((p) => ({ id: p.id, name: p.name, description: p.id === "my-guide" ? "Your original guide, kept safe when you try a preset." : "Your edited copy; built-in presets stay unchanged.", builtin: false })),
    ];
    const tree = builtinCrewTrees()[document.activePreset] ?? document.copies.find((p) => p.id === document.activePreset)!.tree;
    return { tree: clean({ ...tree, mode: document.mode }), activePreset: document.activePreset, presets, catalog: this.catalog(), file: this.file, problem };
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

  /**
   * The tree as it is on disk now. A file that is unreadable or invalid is said so, and the default
   * stands in for it. A file from before the switch and the backups is filled in as it is read and
   * becomes current on its next save.
   */
  state(): CrewTreeState {
    try {
      return this.present(this.readDocument(), null);
    } catch (err) {
      const problem = err instanceof SyntaxError ? `not valid JSON (${err.message})` : (err as Error).message;
      return this.present(this.defaults(), `${this.file} cannot be used, so the default tree stands in for it: ${problem}`);
    }
  }

  save(input: unknown): CrewTreeState {
    // Never replace a damaged original with the fallback shown by state().
    let document: CrewGuideDocument;
    try { document = this.readDocument(); }
    catch (err) { throw new InboxError(422, `The crew tree was not saved; repair the existing file first: ${(err as Error).message}`); }
    const update = input as CrewTreeUpdate;
    const refuse = (message: string): never => { throw new InboxError(422, `The crew tree was not saved: ${message}`); };
    if (!update || typeof update !== "object" || Array.isArray(update)) refuse("expected a tree or preset action");
    if ("action" in update && update.action === "select") {
      document.activePreset = update.presetId;
    } else if ("action" in update && update.action === "mode") {
      document.mode = update.mode;
    } else {
      if ("action" in update && update.action !== "edit") refuse("unknown preset action");
      const tree = "action" in update ? update.tree : update;
      const problems = validateCrewTree(tree, this.catalog());
      if (problems.length) refuse(problems.map((p) => `${p.path}: ${p.message}`).join("; "));
      const id = "action" in update ? update.presetId : document.activePreset;
      const builtin = BUILTIN_PRESETS.find((p) => p.id === id);
      const copy = document.copies.find((p) => p.id === id);
      if (!builtin && !copy) refuse("choose an existing preset or copy");
      const cleaned = clean({ ...tree, mode: MIXED });
      const original = clean({ ...(builtin ? builtinCrewTrees()[id]! : copy!.tree), mode: MIXED });
      if (JSON.stringify(cleaned) !== JSON.stringify(original)) {
        if (builtin) {
          const nameBase = `${builtin.name} (my copy)`;
          let name = nameBase;
          for (let n = 2; document.copies.some((p) => p.name === name); n++) name = `${nameBase} ${n}`;
          const saved = { id: `copy-${randomUUID()}`, name, tree: cleaned };
          document.copies.push(saved);
          document.activePreset = saved.id;
        } else { copy!.tree = cleaned; document.activePreset = id; }
      }
      // Legacy tree PUTs retain their original switch behavior. Explicit edits cannot reset it.
      if (!("action" in update)) document.mode = tree.mode;
    }
    const problems = validateCrewGuide(document, this.catalog());
    if (problems.length) refuse(problems.map((p) => `${p.path}: ${p.message}`).join("; "));
    document.copies = document.copies.map((p) => ({ id: p.id, name: p.name.trim(), tree: clean(p.tree) }));
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`);
    renameSync(temp, this.file);
    return this.state();
  }

  /** What a new project's lead runs on: its choice under the founder's switch as it is now. */
  lead(): CrewChoice {
    const { tree, catalog } = this.state();
    return effectiveLead({ ...tree, mode: pausedMode(tree, catalog, this.pause()) });
  }

  /** What a lead reads: the tree, compact, each choice with the command that starts it. */
  text(): string {
    const { tree, catalog, problem, activePreset, presets } = this.state();
    return `${crewText(tree, catalog, problem, this.pause())}\nActive preset: ${presets.find((p) => p.id === activePreset)!.name}`;
  }
}

/** The words after `--` on `herdr agent start`: the harness's own flags for this model and effort. */
export function startFlags(c: CrewChoice): string[] {
  return c.harness === "pi" ? ["--model", `${c.model}:${c.effort}`] : ["--model", c.model, "--effort", c.effort];
}
const startArgs = (c: CrewChoice): string => startFlags(c).join(" ");

export const startCommand = (c: CrewChoice): string => `herdr agent start <name> --kind ${c.harness} --pane "$P" -- ${startArgs(c)}`;

export function crewText(tree: CrewTree, catalog: CrewCatalog, problem: string | null = null, pause: CrewPause | null = null): string {
  const label = (id: string) => catalog.harnesses.find((x) => x.id === id)?.label ?? id;
  const describe = (c: CrewChoice) => {
    const h = catalog.harnesses.find((x) => x.id === c.harness);
    const name = h?.models.find((m) => m.id === c.model)?.label ?? modelLabel(c.model);
    return `${name}, ${c.effort} effort, in ${h?.label ?? c.harness}`;
  };
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  // Only the choice the switch allows is printed, so a lead cannot pick the harness that is switched off.
  const mode = pausedMode(tree, catalog, pause);
  const pick = (use: CrewChoice, backup: CrewChoice | undefined) => effectiveChoice(mode, use, backup);
  const off = tree.mode === MIXED ? [] : catalog.harnesses.filter((h) => h.id !== tree.mode).map((h) => h.label);
  const lines = [
    tree.mode !== MIXED
      ? `The founder's switch: ${label(tree.mode)} only. ${off.join(" and ")} ${off.length === 1 ? "is" : "are"} switched off by the founder: every choice below already runs on ${label(tree.mode)}, so never start ${off.join(" or ")}, whatever the rule or a crew member suggests.`
      : mode !== MIXED
        ? `The founder's switch: mixed, but the office has paused ${label(pause!.harness)} for now: ${pause!.why}. Every choice below already runs on ${label(mode)} (the rule's backup), so never start ${label(pause!.harness)} until this line is gone, whatever the rule or a crew member suggests. Crew already running carry on.`
        : pause?.onCredits
          ? `The founder's switch: mixed. Each rule's own choice applies: ${label(pause.harness)} stays available although its limit is near or reached, since ${pause.why}.`
          : "The founder's switch: mixed. Each rule's own choice applies.",
    "Crew guide (the founder's decision tree; they edit it, so read it again before each crew member): take the first rule whose \"when\" fits the task. A rule with sub-rules is a question that narrows further; its own choice applies when none of its sub-rules fits. Start the member with the command shown, with `P=$(inbox pane)` and a unique lowercase <name>. Never any other harness or model.",
  ];
  if (problem) lines.push(`Note: ${problem}`);
  const walk = (rules: CrewRule[], prefix: string, indent: string) =>
    rules.forEach((r, i) => {
      const n = `${prefix}${i + 1}`;
      lines.push(`${indent}${n}. When: ${one(r.when)}`);
      if (r.use) {
        const c = pick(r.use, r.backup);
        lines.push(`${indent}   Use: ${describe(c)}${r.why ? `. ${one(r.why)}` : ""}`);
        lines.push(`${indent}   Start: ${startCommand(c)}`);
      }
      if (r.children?.length) {
        lines.push(`${indent}   ${r.use ? "Sub-rules, checked first; the choice above applies when none fits:" : "Sub-rules, to narrow further:"}`);
        walk(r.children, `${n}.`, `${indent}   `);
      }
    });
  walk(tree.rules, "", "");
  const fb = pick(tree.fallback, tree.fallback.backup);
  lines.push(`Otherwise: ${describe(fb)}${tree.fallback.why ? `. ${one(tree.fallback.why)}` : ""}`, `   Start: ${startCommand(fb)}`);
  return lines.join("\n");
}
