import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinCrewTrees, CrewTreeStore } from "../src/server/crewtree.ts";
import { BUILTIN_PRESETS, effectiveChoice, validateCrewGuide, validateCrewTree, type CrewChoice, type CrewTree } from "../src/shared/crewtree.ts";
import { crewTreeSchema } from "../src/server/request-validation.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "crew-presets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new CrewTreeStore(dir, { piStore: join(dir, "no-store") });
}
const select = (crew: CrewTreeStore, presetId: string) => crew.save({ action: "select", presetId });
const edit = (crew: CrewTreeStore, presetId: string, tree: CrewTree) => crew.save({ action: "edit", presetId, tree });
function pairs(tree: CrewTree): Array<[CrewChoice, CrewChoice]> {
  const result: Array<[CrewChoice, CrewChoice]> = [[tree.lead.use, tree.lead.backup], [tree.fallback, tree.fallback.backup]];
  const walk = (rules: CrewTree["rules"]) => { for (const rule of rules) { if (rule.use) result.push([rule.use, rule.backup!]); walk(rule.children ?? []); } };
  walk(tree.rules);
  return result;
}

test("legacy guides stay active as My guide, survive selecting every preset and a restart", (t) => {
  const crew = fixture(t);
  const old = builtinCrewTrees().balanced!;
  old.mode = "pi";
  old.rules[0]!.when = "The founder's original custom rule";
  writeFileSync(crew.file, JSON.stringify(old));
  const bytes = readFileSync(crew.file, "utf8");
  assert.equal(crew.state().activePreset, "my-guide");
  assert.equal(readFileSync(crew.file, "utf8"), bytes, "migration is not a read side effect");
  assert.match(crew.text(), /Active preset: My guide/);
  for (const preset of BUILTIN_PRESETS) {
    const s = select(crew, preset.id);
    assert.equal(s.activePreset, preset.id);
    assert.equal(s.tree.mode, "pi", "preset selection never resets the switch");
    assert.match(crew.text(), new RegExp(`Active preset: ${preset.name}`));
  }
  const restarted = new CrewTreeStore(join(crew.file, ".."), { piStore: "/nonexistent" });
  assert.equal(restarted.state().activePreset, "claude-only");
  assert.deepEqual(select(restarted, "my-guide").tree, old);
});

test("built-in edits fork durable independent copies, never replace My guide or the built-in", (t) => {
  const crew = fixture(t);
  const original = select(crew, "my-guide").tree;
  const top = select(crew, "top-models").tree;
  const edited = structuredClone(top);
  edited.rules[0]!.when = "My first change";
  const first = edit(crew, "top-models", edited);
  assert.notEqual(first.activePreset, "top-models");
  assert.equal(first.presets.find((p) => p.id === first.activePreset)?.builtin, false);
  assert.equal(first.presets.find((p) => p.id === first.activePreset)?.name, "Top models only (my copy)");
  assert.deepEqual(select(crew, "my-guide").tree, original);
  assert.deepEqual(select(crew, "top-models").tree, top);
  edited.rules[0]!.when = "Another experiment";
  const second = edit(crew, "top-models", edited);
  assert.notEqual(first.activePreset, second.activePreset);
  assert.equal(second.presets.find((p) => p.id === second.activePreset)?.name, "Top models only (my copy) 2");
  assert.equal(select(crew, first.activePreset).tree.rules[0]!.when, "My first change");
  edited.rules[0]!.when = "Refining the first copy";
  const refined = edit(crew, first.activePreset, edited);
  assert.equal(refined.activePreset, first.activePreset);
  assert.equal(refined.presets.length, second.presets.length, "editing a custom guide updates it, not a fresh fork");
  assert.equal(select(crew, second.activePreset).tree.rules[0]!.when, "Another experiment");
});

test("mode-only and no-op edits do not fork; edits preserve the current global switch", (t) => {
  const crew = fixture(t);
  select(crew, "top-models");
  const draft = crew.state().tree;
  crew.save({ action: "mode", mode: "pi" });
  assert.equal(crew.state().activePreset, "top-models");
  assert.equal(edit(crew, "top-models", draft).activePreset, "top-models");
  draft.rules[0]!.when = "Draft made before the switch changed";
  assert.equal(edit(crew, "top-models", draft).tree.mode, "pi");
  const count = crew.state().presets.length;
  crew.save({ ...crew.state().tree, mode: "claude" });
  assert.equal(crew.state().presets.length, count, "legacy mode-only updates also avoid copies");
});

test("presets have valid exact model ids, top-model pairs, economical work and single-harness main choices", (t) => {
  const crew = fixture(t);
  const trees = builtinCrewTrees();
  const known = new Set(["opus", "sonnet", "openai-codex/gpt-6-astra", "openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-luna"]);
  for (const tree of Object.values(trees)) {
    assert.deepEqual(validateCrewTree(tree, crew.catalog()), []);
    for (const pair of pairs(tree)) for (const c of pair) assert.ok(known.has(c.model));
  }
  for (const pair of pairs(trees["top-models"]!)) {
    assert.deepEqual(new Set(pair.map((c) => c.model)), new Set(["opus", "openai-codex/gpt-6-astra"]));
    assert.deepEqual(new Set(pair.map((c) => c.harness)), new Set(["claude", "pi"]));
  }
  assert.equal(trees.thrifty!.rules[0]!.use!.model, "openai-codex/gpt-6-luna");
  assert.equal(trees.thrifty!.rules[0]!.use!.effort, "high");
  for (const pair of pairs(trees.thrifty!)) for (const c of pair) assert.ok(!["opus", "openai-codex/gpt-6-astra"].includes(c.model));
  for (const [id, harness] of [["codex-only", "pi"], ["claude-only", "claude"]]) {
    for (const [use, backup] of pairs(trees[id!]!)) {
      assert.equal(use.harness, harness);
      assert.notEqual(backup.harness, harness, "retain an escape hatch for the founder's override");
    }
  }
});

test("every preset obeys the founder's switch and the temporary usage pause, including lead and fallback", (t) => {
  const crew = fixture(t);
  for (const preset of BUILTIN_PRESETS) {
    select(crew, preset.id);
    for (const mode of ["pi", "claude"]) {
      crew.save({ action: "mode", mode });
      for (const [use, backup] of pairs(crew.state().tree)) assert.equal(effectiveChoice(mode, use, backup).harness, mode);
      assert.equal(crew.lead().harness, mode);
      const text = crew.text();
      assert.ok(text.split("\n").filter((l) => l.includes("Start: ")).every((l) => l.includes(`--kind ${mode} `)));
      crew.pause = () => ({ harness: mode, why: "synthetic limit" });
      assert.equal(crew.lead().harness, mode, "explicit switch wins over the pause");
      assert.doesNotMatch(crew.text(), /paused/);
    }
    crew.save({ action: "mode", mode: "mixed" });
    assert.equal(crew.lead().harness, "pi", "paused Claude is replaced by Pi");
    assert.match(crew.text(), /paused Claude Code/);
    assert.doesNotMatch(crew.text(), /--kind claude/);
    crew.pause = () => ({ harness: "pi", why: "synthetic limit" });
    assert.equal(crew.lead().harness, "claude");
    assert.doesNotMatch(crew.text(), /--kind pi/);
  }
});

test("invalid persistence, inactive copies, and unknown selections are rejected without losing the original", (t) => {
  const crew = fixture(t);
  crew.state();
  const before = readFileSync(crew.file, "utf8");
  for (const input of [{ action: "select", presetId: "missing" }, { action: "mode", mode: "codex" }, { action: "bogus" }, null]) {
    assert.throws(() => crew.save(input));
    assert.equal(readFileSync(crew.file, "utf8"), before);
  }
  const document = JSON.parse(before);
  for (const broken of [
    { ...document, activePreset: "missing" },
    { ...document, copies: [] },
    { ...document, copies: [...document.copies, document.copies[0]] },
    { ...document, copies: [{ ...document.copies[0], id: "balanced" }] },
    { ...document, copies: [{ ...document.copies[0], tree: { ...document.copies[0].tree, rules: [{ when: "invalid" }] } }] },
  ]) assert.ok(validateCrewGuide(broken, crew.catalog()).length);
  writeFileSync(crew.file, "{broken original");
  assert.ok(crew.state().problem);
  assert.throws(() => select(crew, "balanced"), /repair the existing file/);
  assert.equal(readFileSync(crew.file, "utf8"), "{broken original");
});

test("HTTP request decoder accepts preset actions and still validates complete edit trees", (t) => {
  const crew = fixture(t);
  const request = { action: "select", presetId: "top-models" };
  assert.deepEqual(crewTreeSchema.parse(request), request);
  assert.equal(crew.save(crewTreeSchema.parse(request)).activePreset, "top-models");
  assert.deepEqual(crewTreeSchema.parse({ action: "mode", mode: "pi" }), { action: "mode", mode: "pi" });
  const tree = crew.state().tree;
  tree.rules[0]!.when = "Changed through the decoder";
  assert.notEqual(crew.save(crewTreeSchema.parse({ action: "edit", presetId: "top-models", tree })).activePreset, "top-models");
  assert.throws(() => crewTreeSchema.parse({ action: "edit", presetId: "top-models", tree: {} }));
  assert.throws(() => crewTreeSchema.parse({ action: "unknown" }));
});
