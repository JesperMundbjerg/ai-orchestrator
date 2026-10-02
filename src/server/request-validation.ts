// UI/control request decoders. Agent decoders live in the public protocol module; both
// start from unknown. Syntax/type checks belong here, state/revision rules stay in the domain.
import {
  object, optional, nullable, list, text, nonempty, boolean, positiveInteger, oneOf,
  timestamp, record, refine, fail, validateToolInput, type Schema,
} from "../shared/agent-protocol.ts";
import type { CrewRule, CrewTree } from "../shared/crewtree.ts";

const maybeText = optional(text);
// The legacy image contract treats null as no attachments, just like omission.
const images: Schema<string[] | undefined> = { parse: (v, p) => v === null ? undefined : optional(list(nonempty)).parse(v, p) };
export const answerSchema = object({
  id: optional(nonempty), revision: positiveInteger,
  action: oneOf(["choose", "answer", "accept", "request_changes", "discuss"]),
  choice: optional(nullable(text)), text: maybeText, images,
});
export const snoozeSchema = object({ until: timestamp });
export const taskPatchSchema = object({
  title: maybeText, objective: maybeText, activity: maybeText, nextMilestone: maybeText,
  lastDecision: maybeText, lastAcceptedMilestone: maybeText, parked: optional(boolean),
});
export const pinSchema = object({ pinned: boolean });
export const uploadSchema = object({ data: nonempty });
export const teamCreateSchema = object({
  name: nonempty, purpose: maybeText, handsTo: optional(nullable(text)), repository: maybeText, standing: optional(boolean),
});
export const teamPatchSchema = object({ name: maybeText, purpose: maybeText, handsTo: optional(nullable(text)) });
export const worktreeSchema = object({ path: nonempty });
export const mergeSchema = object({ into: nonempty });
export const messageSchema = object({ text: maybeText, images, clientId: optional(nonempty) });
export const allLeadsSchema = object({
  text: maybeText, images, clientId: nonempty, leadIds: optional(list(nonempty)),
});
export const agentPatchSchema = object({ name: maybeText, teamId: optional(nullable(text)), role: optional(oneOf(["lead", "member"])), takeName: optional(boolean) });
export const setEffortSchema = object({ level: nonempty });

const choice = object({ harness: nonempty, model: nonempty, effort: nonempty });
// Bound recursion before walking hostile JSON, even when a nested rule's fields are well typed.
const ruleAt = (depth: number): Schema<CrewRule> => ({ parse(input, path = "") {
  const source = record.parse(input, path);
  if (depth >= 4 && Array.isArray(source.children) && source.children.length) fail(`${path}.children`, "rules nest at most 4 deep");
  return object({ id: nonempty, when: nonempty, use: optional(choice), backup: optional(choice), why: maybeText,
    children: optional(list(ruleAt(depth + 1))),
  }).parse(source, path);
} });
export const crewTreeSchema: Schema<CrewTree> = refine(object({
  version: oneOf([1]), mode: nonempty, rules: list(ruleAt(1)),
  fallback: object({ harness: nonempty, model: nonempty, effort: nonempty, backup: choice, why: maybeText }),
  lead: object({ use: choice, backup: choice, why: maybeText }),
}), (tree, path) => {
  let count = 0;
  const walk = (rules: CrewRule[]) => { for (const rule of rules) { count++; walk(rule.children ?? []); } };
  walk(tree.rules);
  if (count > 60) fail(path ? `${path}.rules` : "rules", "at most 60 rules");
});

// Hooks are deliberately extensible records: these are only the fields this service consumes.
// Valid hook input still receives {} and never produces a harness decision.
export const claudeHookSchema = refine(object({
  session_id: maybeText, cwd: maybeText, hook_event_name: maybeText, agent_id: maybeText,
  agent_type: maybeText, model: maybeText, transcript_path: maybeText, tool_name: maybeText, tool_input: optional(record),
}), (hook, path) => {
  if (hook.hook_event_name === "PreToolUse") validateToolInput(hook.tool_name, hook.tool_input, path ? `${path}.tool_input` : "tool_input");
});
