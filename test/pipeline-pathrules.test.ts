import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatches, pathProblems, validateGraph } from "../src/server/pipelines/model.ts";
import type { PipelineGraph, PipelinePathRule } from "../src/shared/pipeline.ts";

const EXCEPT = ["**/*.test.mjs", "**/*.test.ts", "**/__tests__/**"];
const PREFIXES = ["space-app/app", "space-app/public", "space-app/messages"];
const base = (): PipelineGraph => ({ version: 1, id: "wave", label: "Path rules", entry: "checks", fields: [{ id: "visible", label: "Visible", type: "boolean" }],
  nodes: [{ id: "checks", label: "Verify candidate", kind: "step", source: "builtin:check", evidence: ["check"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "handoff" }],
  edges: [{ id: "finish", from: "checks", to: "deliver" }] });
const withRules = (...rules: unknown[]) => ({ ...base(), pathRules: rules });
const visible = (extra: Partial<PipelinePathRule> = {}): PipelinePathRule => ({ prefixes: PREFIXES, require: { field: "visible", equals: true }, message: "choose the visible branch", ...extra });
const graphOf = (rule: PipelinePathRule): PipelineGraph => ({ ...base(), pathRules: [rule] });
const MSG = ["choose the visible branch"];

test("globs: * and ? stay in one segment, ** crosses segments, brackets are literal", () => {
  const yes: Array<[string, string]> = [
    ["**/*.test.mjs", "space-app/app/[locale]/page.test.mjs"], ["**/*.test.mjs", "page.test.mjs"], ["**/*.test.ts", "a/b/c/d.test.ts"],
    ["**/__tests__/**", "space-app/app/__tests__/x.tsx"], ["**/__tests__/**", "__tests__/deep/er/x.ts"],
    ["src/*.ts", "src/a.ts"], ["src/**", "src/a/b.ts"], ["src/a?.ts", "src/ab.ts"], ["a/**/b.ts", "a/b.ts"], ["a/**/b.ts", "a/x/y/b.ts"],
    ["space-app/app/[locale]/*.mjs", "space-app/app/[locale]/x.mjs"], ["a.b", "a.b"],
  ];
  const no: Array<[string, string]> = [
    ["**/*.test.mjs", "space-app/app/[locale]/page.mjs"], ["**/*.test.mjs", "space-app/app/page.test.mjs.bak"], ["**/*.test.mjs", "page.test.ts"],
    ["**/__tests__/**", "space-app/app/__tests__"], ["**/__tests__/**", "space-app/app/my__tests__/x.ts"],
    ["src/*.ts", "src/a/b.ts"], ["src/a?.ts", "src/a/.ts"], ["src/a?.ts", "src/a.ts"], ["a.b", "axb"], ["a/**/b.ts", "ab.ts"],
    ["space-app/app/[locale]/*.mjs", "space-app/app/l/x.mjs"], ["src/*.ts", "SRC/a.ts"], ["a+b", "aab"], ["(a)", "a"],
  ];
  for (const [g, p] of yes) assert.equal(globMatches(g, p), true, `${g} should match ${p}`);
  for (const [g, p] of no) assert.equal(globMatches(g, p), false, `${g} should not match ${p}`);
});

test("require rule with except: a test-only change under the prefix is no longer flagged", () => {
  const g = graphOf(visible({ except: EXCEPT }));
  for (const path of ["space-app/app/[locale]/page.test.mjs", "space-app/app/lib/util.test.ts", "space-app/app/[locale]/__tests__/page.tsx"])
    assert.deepEqual(pathProblems(g, { visible: false }, [path]), [], path);
  assert.deepEqual(pathProblems(g, { visible: false }, ["space-app/app/a.test.mjs", "space-app/app/b.test.ts"]), []);
});

test("require rule with except: a real route file next to the test is still flagged, alone or mixed", () => {
  const g = graphOf(visible({ except: EXCEPT }));
  assert.deepEqual(pathProblems(g, { visible: false }, ["space-app/app/[locale]/page.tsx"]), MSG);
  assert.deepEqual(pathProblems(g, { visible: false }, ["space-app/app/[locale]/page.test.mjs", "space-app/app/[locale]/page.tsx"]), MSG);
  assert.deepEqual(pathProblems(g, { visible: false }, ["space-app/public/logo.svg", "space-app/messages/en.json"]), MSG);
  assert.deepEqual(pathProblems(g, { visible: true }, ["space-app/app/[locale]/page.tsx"]), [], "the visible branch satisfies the rule");
  assert.deepEqual(pathProblems(g, { visible: false }, ["scripts/build.mjs"]), [], "outside the prefixes it never applied");
});

test("only rule with except: excepted paths do not break the bound, the rest still must match", () => {
  const docs = (except?: string[]): PipelineGraph => graphOf({ prefixes: ["docs", "README.md"], only: true, message: "docs only", ...(except ? { except } : {}) });
  // Without except a test file outside the prefixes breaks the bound; with except it is ignored.
  assert.deepEqual(pathProblems(docs(), {}, ["docs/a.md", "tools/x.test.ts"]), ["docs only"]);
  assert.deepEqual(pathProblems(docs(EXCEPT), {}, ["docs/a.md", "tools/x.test.ts"]), []);
  assert.deepEqual(pathProblems(docs(EXCEPT), {}, ["tools/x.test.ts"]), [], "only excepted paths: nothing counts");
  assert.deepEqual(pathProblems(docs(EXCEPT), {}, ["docs/a.md", "tools/x.test.ts", "src/real.ts"]), ["docs only"], "a real out-of-bound path is still caught");
  // `when` still gates the rule.
  const gated: PipelineGraph = { ...base(), pathRules: [{ when: { field: "visible", equals: true }, prefixes: ["docs"], only: true, except: EXCEPT, message: "gated" }] };
  assert.deepEqual(pathProblems(gated, { visible: false }, ["src/real.ts"]), []);
  assert.deepEqual(pathProblems(gated, { visible: true }, ["src/real.ts"]), ["gated"]);
  assert.deepEqual(pathProblems(gated, { visible: true }, ["src/real.test.ts"]), []);
});

test("rules without except behave exactly as before", () => {
  const g = graphOf(visible());
  assert.deepEqual(pathProblems(g, { visible: false }, ["space-app/app/[locale]/page.test.mjs"]), MSG, "tests under the prefix still count");
  assert.deepEqual(pathProblems(g, { visible: true }, ["space-app/app/[locale]/page.test.mjs"]), []);
  assert.deepEqual(pathProblems(g, { visible: false }, ["space-app/application.ts", "other.ts"]), [], "prefix match is whole segments");
  assert.deepEqual(pathProblems(g, { visible: false }, []), []);
  // an explicitly empty list never reaches pathProblems through validation, but a stored rule with [] still means "nothing excepted"
  assert.deepEqual(pathProblems(graphOf(visible({ except: [] })), { visible: false }, ["space-app/app/a.test.mjs"]), MSG);
});

test("validation: except round-trips through validateGraph, and bad values give clear errors", () => {
  const rule = { prefixes: PREFIXES, require: { field: "visible", equals: true }, message: "m", except: EXCEPT };
  assert.deepEqual(validateGraph(withRules(rule)).pathRules, [rule]);
  assert.equal("except" in validateGraph(withRules({ ...rule, except: undefined })).pathRules![0]!, false);
  const refused = (except: unknown, pattern: RegExp) => assert.throws(() => validateGraph(withRules({ ...rule, except })), { code: "pipeline_invalid", message: pattern });
  refused("**/*.test.ts", /expected a list/);
  refused(null, /expected a list/);
  refused({ 0: "a" }, /expected a list/);
  refused([], /at least one glob/);
  refused([1], /non-empty strings/);
  refused(["**/*.test.ts", null], /non-empty strings/);
  refused([{ glob: "**/*.test.ts" }], /non-empty strings/);
  refused([""], /non-empty strings/);
  refused(["  "], /non-empty strings/);
  refused(["/etc/*.ts"], /repo-relative/);
  refused(["../x/*.ts"], /repo-relative/);
  refused(["a\\b"], /repo-relative/);
  refused(["a".repeat(201)], /repo-relative/);
});

test("the FysikLab rule from Mission Control validates and behaves as described", () => {
  const g = validateGraph(withRules({ prefixes: PREFIXES, require: { field: "visible", equals: true }, message: "Routes/public assets/locales are user-visible: choose the visible branch", except: EXCEPT }));
  assert.deepEqual(pathProblems(g, { visible: false }, ["space-app/app/[locale]/page.test.mjs"]), []);
  assert.equal(pathProblems(g, { visible: false }, ["space-app/app/[locale]/page.test.mjs", "space-app/app/[locale]/page.tsx"]).length, 1);
});
