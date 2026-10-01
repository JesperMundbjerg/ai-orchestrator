// The crew tree: the decision tree a project's lead follows to pick each crew member's harness and
// model. The founder edits it; the leads read it and decide (no model sits in the middle). These
// are its types and its validation, shared by the service and the editor. What a harness, a model
// or an effort is comes from the catalog the service supplies, so nothing here names a vendor.

import { modelLabel } from "./models.ts";

export interface CrewChoice {
  harness: string;
  model: string;
  effort: string;
}

export interface CrewRule {
  id: string;
  /** The task this rule covers, in the founder's words. */
  when: string;
  /** What to start. A rule with children may leave it out. */
  use?: CrewChoice;
  /** What to start instead when the founder switches `use`'s harness off; always on the other harness. Required beside `use`. */
  backup?: CrewChoice;
  why?: string;
  /** Questions that narrow this rule further; its own `use` applies when none of them fits. */
  children?: CrewRule[];
}

/** The founder's switch: "mixed" follows each rule's own choice; a harness id runs everything on that harness. */
export const MIXED = "mixed";

/** The project lead's own choice, picked like a rule's. */
export interface CrewLead {
  use: CrewChoice;
  backup: CrewChoice;
  why?: string;
}

export interface CrewTree {
  version: 1;
  /** "mixed", or the id of the one harness everything runs on while the other is switched off. */
  mode: string;
  rules: CrewRule[];
  fallback: CrewChoice & { backup: CrewChoice; why?: string };
  lead: CrewLead;
}

/** What can be picked: harnesses with their models and efforts, as data for a generic editor. */
export interface CrewCatalog {
  harnesses: Array<{
    id: string;
    label: string;
    models: Array<{ id: string; label: string }>;
    efforts: string[];
  }>;
}

export interface CrewTreeState {
  tree: CrewTree;
  catalog: CrewCatalog;
  /** Where the tree is kept, for anyone who prefers to edit the file. */
  file: string;
  /** Said when the file on disk could not be used and the default is shown instead. */
  problem: string | null;
}

export interface CrewProblem {
  /** Dotted path into the tree: "rules.0.children.1.when", "fallback.model". */
  path: string;
  message: string;
}

export const MAX_DEPTH = 4;
export const MAX_RULES = 60;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;

/**
 * What the model picker offers for a choice: the catalog's models for its harness, and the chosen
 * model too when the catalog does not list it (a hand edit, or a model added since), so the
 * picker keeps it and shows it rather than blanking it.
 */
export function modelOptions(catalog: CrewCatalog, choice: CrewChoice): Array<{ id: string; label: string; listed: boolean }> {
  const listed = (catalog.harnesses.find((h) => h.id === choice.harness)?.models ?? []).map((m) => ({ ...m, listed: true }));
  if (!choice.model || listed.some((m) => m.id === choice.model)) return listed;
  return [{ id: choice.model, label: `${modelLabel(choice.model)} (not in the list)`, listed: false }, ...listed];
}

/**
 * What to start for a choice and its backup under the founder's switch: mixed takes the choice as
 * written; a harness takes whichever of the two runs on it (the choice itself when neither does).
 */
export function effectiveChoice(mode: string, use: CrewChoice, backup: CrewChoice | undefined): CrewChoice {
  if (mode === MIXED || use.harness === mode) return use;
  return backup && backup.harness === mode ? backup : use;
}

export const effectiveLead = (tree: Pick<CrewTree, "mode" | "lead">): CrewChoice => effectiveChoice(tree.mode, tree.lead.use, tree.lead.backup);

/**
 * A backup on the other harness for a choice, for a tree that has none yet: Opus and GPT-6 Astra
 * stand in for each other, Sonnet and GPT-6.1 Sol likewise, and whatever else falls to the everyday
 * pair. Deterministic, so an old file reads the same every time until it is saved.
 */
export function defaultBackup(c: CrewChoice): CrewChoice {
  const m = c.model.toLowerCase();
  if (c.harness === "claude") {
    if (m.includes("opus") || m.includes("fable")) return { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "high" };
    if (m.includes("haiku")) return { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "low" };
    return { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" };
  }
  if (m.includes("astra")) return { harness: "claude", model: "opus", effort: "medium" };
  return { harness: "claude", model: "sonnet", effort: "high" };
}

/** The project lead's choice when a tree has none: Opus at medium effort, GPT-6 Astra as its backup. */
export const DEFAULT_LEAD: CrewLead = {
  use: { harness: "claude", model: "opus", effort: "medium" },
  backup: { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "high" },
};

/**
 * An older tree made current: the mode, the lead and a backup beside every choice are filled in
 * where missing, and nothing else is touched. What is not a tree is returned as it is, for
 * validation to refuse.
 */
export function upgradeCrewTree(input: unknown): unknown {
  const t = input as Partial<CrewTree> | null;
  if (!t || typeof t !== "object" || Array.isArray(t)) return input;
  const isChoice = (c: unknown): c is CrewChoice => !!c && typeof c === "object" && typeof (c as CrewChoice).harness === "string" && typeof (c as CrewChoice).model === "string";
  const rule = (r: unknown): unknown => {
    const x = r as CrewRule | null;
    if (!x || typeof x !== "object") return r;
    return {
      ...x,
      ...(isChoice(x.use) && x.backup === undefined ? { backup: defaultBackup(x.use) } : {}),
      ...(Array.isArray(x.children) ? { children: x.children.map(rule) } : {}),
    };
  };
  const fb = t.fallback as CrewTree["fallback"] | undefined;
  return {
    ...t,
    mode: t.mode ?? MIXED,
    ...(Array.isArray(t.rules) ? { rules: t.rules.map(rule) } : {}),
    ...(isChoice(fb) && fb.backup === undefined ? { fallback: { ...fb, backup: defaultBackup(fb) } } : {}),
    lead: t.lead ?? structuredClone(DEFAULT_LEAD),
  };
}

export function newRuleId(): string {
  return `rule-${Math.random().toString(36).slice(2, 8)}`;
}

/** A tree's problems, each with where it is; none means it can be saved. `input` may be anything. */
export function validateCrewTree(input: unknown, catalog: CrewCatalog): CrewProblem[] {
  const problems: CrewProblem[] = [];
  const add = (path: string, message: string) => void problems.push({ path, message });
  const tree = input as Partial<CrewTree> | null;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return [{ path: "", message: "the tree must be an object" }];
  if (tree.version !== 1) add("version", "version must be 1");
  const modes = [MIXED, ...catalog.harnesses.map((h) => h.id)];
  if (!modes.includes(tree.mode as string)) add("mode", `mode must be one of ${modes.join(", ")}`);
  const choice = (path: string, c: unknown) => {
    const x = c as Partial<CrewChoice> | null;
    if (!x || typeof x !== "object") return add(path, "choose a harness, model and effort");
    const harness = catalog.harnesses.find((h) => h.id === x.harness);
    if (!harness) return add(`${path}.harness`, `harness must be one of ${catalog.harnesses.map((h) => h.id).join(", ")}`);
    if (typeof x.model !== "string" || !MODEL.test(x.model)) add(`${path}.model`, "pick a model (letters, digits, . _ / - only)");
    if (typeof x.effort !== "string" || !harness.efforts.includes(x.effort)) add(`${path}.effort`, `effort for ${harness.label} must be one of ${harness.efforts.join(", ")}`);
  };
  // A choice and the backup the switch turns to: each valid, and on different harnesses, so either switch position has one.
  const pair = (path: string, use: unknown, backupPath: string, backup: unknown) => {
    choice(path, use);
    if (backup === undefined || backup === null) return add(backupPath, "choose a backup on the other harness");
    choice(backupPath, backup);
    const a = (use as Partial<CrewChoice> | null)?.harness;
    const b = (backup as Partial<CrewChoice> | null)?.harness;
    if (typeof a === "string" && a === b) add(`${backupPath}.harness`, "the backup must be on the other harness");
  };
  const seen = new Set<string>();
  let count = 0;
  const rule = (r: unknown, path: string, depth: number) => {
    const x = r as Partial<CrewRule> | null;
    if (!x || typeof x !== "object") return add(path, "a rule must be an object");
    if (++count > MAX_RULES) return add(path, `at most ${MAX_RULES} rules`);
    if (typeof x.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x.id)) add(`${path}.id`, "id must be a lowercase slug");
    else if (seen.has(x.id)) add(`${path}.id`, `id "${x.id}" is used twice`);
    else seen.add(x.id);
    if (typeof x.when !== "string" || !x.when.trim()) add(`${path}.when`, "say when this rule applies");
    else if (x.when.length > 600) add(`${path}.when`, "keep it under 600 characters");
    if (x.why !== undefined && (typeof x.why !== "string" || x.why.length > 600)) add(`${path}.why`, "keep it under 600 characters");
    const kids = x.children;
    if (kids !== undefined && !Array.isArray(kids)) return add(`${path}.children`, "children must be a list");
    if (x.use !== undefined) pair(`${path}.use`, x.use, `${path}.backup`, x.backup);
    else if (x.backup !== undefined) add(`${path}.backup`, "a backup needs a choice of its own to stand in for");
    else if (!kids?.length) add(`${path}.use`, "choose a model, or add rules beneath this one");
    if (kids?.length && depth >= MAX_DEPTH) add(`${path}.children`, `rules nest at most ${MAX_DEPTH} deep`);
    else kids?.forEach((k, i) => rule(k, `${path}.children.${i}`, depth + 1));
  };
  if (!Array.isArray(tree.rules)) add("rules", "rules must be a list");
  else tree.rules.forEach((r, i) => rule(r, `rules.${i}`, 1));
  const fb = tree.fallback as { why?: unknown; backup?: unknown } | undefined;
  pair("fallback", tree.fallback, "fallback.backup", fb?.backup);
  if (fb && fb.why !== undefined && (typeof fb.why !== "string" || fb.why.length > 600)) add("fallback.why", "keep it under 600 characters");
  const lead = tree.lead as Partial<CrewLead> | undefined;
  if (!lead || typeof lead !== "object") add("lead", "choose what the project lead runs on");
  else {
    pair("lead.use", lead.use, "lead.backup", lead.backup);
    if (lead.why !== undefined && (typeof lead.why !== "string" || lead.why.length > 600)) add("lead.why", "keep it under 600 characters");
  }
  return problems;
}
