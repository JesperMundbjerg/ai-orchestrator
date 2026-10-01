// The crew tree: the decision tree a project's lead follows to pick each crew member's harness and
// model. The founder edits it; the leads read it and decide (no model sits in the middle). These
// are its types and its validation, shared by the service and the editor. What a harness, a model
// or an effort is comes from the catalog the service supplies, so nothing here names a vendor.

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
  why?: string;
  /** Questions that narrow this rule further; its own `use` applies when none of them fits. */
  children?: CrewRule[];
}

export interface CrewTree {
  version: 1;
  rules: CrewRule[];
  fallback: CrewChoice & { why?: string };
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
  const choice = (path: string, c: unknown) => {
    const x = c as Partial<CrewChoice> | null;
    if (!x || typeof x !== "object") return add(path, "choose a harness, model and effort");
    const harness = catalog.harnesses.find((h) => h.id === x.harness);
    if (!harness) return add(`${path}.harness`, `harness must be one of ${catalog.harnesses.map((h) => h.id).join(", ")}`);
    if (typeof x.model !== "string" || !MODEL.test(x.model)) add(`${path}.model`, "pick a model (letters, digits, . _ / - only)");
    if (typeof x.effort !== "string" || !harness.efforts.includes(x.effort)) add(`${path}.effort`, `effort for ${harness.label} must be one of ${harness.efforts.join(", ")}`);
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
    if (x.use !== undefined) choice(`${path}.use`, x.use);
    else if (!kids?.length) add(`${path}.use`, "choose a model, or add rules beneath this one");
    if (kids?.length && depth >= MAX_DEPTH) add(`${path}.children`, `rules nest at most ${MAX_DEPTH} deep`);
    else kids?.forEach((k, i) => rule(k, `${path}.children.${i}`, depth + 1));
  };
  if (!Array.isArray(tree.rules)) add("rules", "rules must be a list");
  else tree.rules.forEach((r, i) => rule(r, `rules.${i}`, 1));
  choice("fallback", tree.fallback);
  const fb = tree.fallback as { why?: unknown } | undefined;
  if (fb && fb.why !== undefined && (typeof fb.why !== "string" || fb.why.length > 600)) add("fallback.why", "keep it under 600 characters");
  return problems;
}
