import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelOptions, validateCrewTree, type CrewTree } from "../src/shared/crewtree.ts";
import { CrewTreeStore } from "../src/server/crewtree.ts";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World } from "../src/server/world.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "crew-tree-"));

/** A Pi model store the way Pi writes it, with things in it that must never be read. */
function piStore(dir: string) {
  const file = join(dir, "models-store.json");
  writeFileSync(file, JSON.stringify({
    "openai-codex": {
      models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", baseUrl: "https://example.test", cost: { input: 10 } }, { id: "gpt-6-sol", name: "GPT-6 Sol" }, { id: "bad id; rm -rf", name: "x" }],
      accessToken: "SECRET-TOKEN",
    },
  }));
  return file;
}

const store = (opts: { pi?: boolean } = {}) => {
  const dir = tmp();
  return { dir, crew: new CrewTreeStore(dir, { piStore: opts.pi === false ? join(dir, "none.json") : piStore(dir) }) };
};

const copy = <T,>(x: T): T => structuredClone(x);

test("the default tree is today's guidance, valid, and seeded once without overwriting an edit", () => {
  const { dir, crew } = store();
  assert.equal(existsSync(crew.file), false);
  const first = crew.state();
  assert.equal(first.problem, null);
  assert.deepEqual(validateCrewTree(first.tree, first.catalog), []);
  assert.deepEqual(first.tree.rules.map((r) => [r.use?.harness, r.use?.model, r.use?.effort]), [
    ["claude", "opus", "medium"], ["pi", "openai-codex/gpt-6-astra", "high"], ["claude", "sonnet", "high"],
  ]);
  assert.deepEqual(first.tree.fallback, { harness: "claude", model: "sonnet", effort: "high", why: first.tree.fallback.why });
  assert.ok(existsSync(join(dir, "crew-tree.json")), "kept in the data directory as JSON");

  const edited = copy(first.tree);
  edited.rules[0]!.when = "Anything hard.";
  crew.save(edited);
  new CrewTreeStore(dir, { piStore: "/nowhere" }).seed();
  assert.equal(JSON.parse(readFileSync(crew.file, "utf8")).rules[0].when, "Anything hard.", "seeding never replaces a file that exists");
});

test("validation: when, harness, effort, a choice, ids, depth and unsafe model words", () => {
  const { crew } = store();
  const { tree, catalog } = crew.state();
  const problems = (t: unknown) => validateCrewTree(t, catalog).map((p) => `${p.path}: ${p.message}`);

  const blank = copy(tree);
  blank.rules[0]!.when = "   ";
  assert.match(problems(blank)[0]!, /^rules\.0\.when: say when/);

  const codex = copy(tree) as unknown as { rules: Array<{ use: Record<string, string> }> };
  codex.rules[0]!.use.harness = "codex";
  assert.match(problems(codex)[0]!, /^rules\.0\.use\.harness: harness must be one of claude, pi/);

  const effort = copy(tree);
  effort.rules[0]!.use!.effort = "ludicrous";
  assert.match(problems(effort)[0]!, /^rules\.0\.use\.effort: effort for Claude Code must be one of low, medium, high, xhigh, max/);
  const piEffort = copy(tree);
  piEffort.rules[1]!.use!.effort = "off";
  assert.deepEqual(problems(piEffort), [], "Pi's own levels are known to it");
  piEffort.rules[0]!.use!.effort = "off";
  assert.equal(problems(piEffort).length, 1, "off is not a Claude effort");

  const unsafe = copy(tree);
  unsafe.rules[0]!.use!.model = "opus; rm -rf ~";
  assert.match(problems(unsafe)[0]!, /^rules\.0\.use\.model:/);

  const bare = copy(tree);
  delete bare.rules[0]!.use;
  assert.match(problems(bare)[0]!, /^rules\.0\.use: choose a model, or add rules beneath/);
  bare.rules[0]!.children = [{ id: "inner", when: "Inside", use: { harness: "claude", model: "haiku", effort: "low" } }];
  assert.deepEqual(problems(bare), [], "a rule with sub-rules may leave its own choice out");

  const twice = copy(tree);
  twice.rules[1]!.id = twice.rules[0]!.id;
  assert.match(problems(twice)[0]!, /^rules\.1\.id: id ".*" is used twice/);

  let deep: CrewTree["rules"] = [{ id: "d9", when: "deepest", use: tree.fallback }];
  for (let i = 8; i > 0; i--) deep = [{ id: `d${i}`, when: "level", use: tree.fallback, children: deep }];
  assert.match(problems({ ...tree, rules: deep }).join(" "), /nest at most 4 deep/);

  assert.match(problems({ ...tree, fallback: { harness: "claude", model: "", effort: "high" } })[0]!, /^fallback\.model/);
  assert.match(problems({ ...tree, version: 2 })[0]!, /^version/);
  assert.deepEqual(problems(null), [": the tree must be an object"]);
});

test("saving writes only what is valid, trimmed and without stray fields; a refusal leaves the file alone", () => {
  const { crew } = store();
  const { tree } = crew.state();
  const before = readFileSync(crew.file, "utf8");
  const bad = copy(tree);
  bad.rules[2]!.when = "";
  assert.throws(() => crew.save(bad), (e: Error & { status?: number }) => e.status === 422 && /rules\.2\.when/.test(e.message));
  assert.equal(readFileSync(crew.file, "utf8"), before);

  const good = copy(tree) as CrewTree & { stray?: string };
  good.stray = "x";
  good.rules[0]!.when = "  Hard things.  ";
  good.rules[0]!.why = "   ";
  const saved = crew.save(good);
  assert.equal(saved.tree.rules[0]!.when, "Hard things.");
  const onDisk = JSON.parse(readFileSync(crew.file, "utf8"));
  assert.ok(!("stray" in onDisk) && !("why" in onDisk.rules[0]));
});

test("a hand edit counts at once; a broken file says so and the default stands in", () => {
  const { crew } = store();
  const hand = copy(crew.state().tree);
  hand.rules[2]!.use!.model = "haiku";
  writeFileSync(crew.file, JSON.stringify(hand));
  assert.match(crew.text(), /--kind claude --pane "\$P" -- --model haiku --effort high/);

  writeFileSync(crew.file, "{ not json");
  const s = crew.state();
  assert.match(s.problem!, /cannot be used.*not valid JSON/);
  assert.equal(s.tree.rules.length, 3);
  assert.match(crew.text(), /Note: .*cannot be used/);

  writeFileSync(crew.file, JSON.stringify({ ...hand, rules: [{ id: "x", when: "", use: hand.fallback }] }));
  assert.match(crew.state().problem!, /rules\.0\.when/);
});

test("the catalog holds Pi's model ids and names only, and nothing when Pi has no store", () => {
  const { crew } = store();
  const catalog = crew.catalog();
  assert.deepEqual(catalog.harnesses.map((h) => h.id), ["claude", "pi"]);
  assert.deepEqual(catalog.harnesses[0]!.models.map((m) => m.id), ["opus", "sonnet", "haiku", "fable"]);
  assert.equal(catalog.harnesses[0]!.models.find((m) => m.id === "fable")?.label, "Fable 5.1");
  assert.deepEqual(catalog.harnesses[1]!.models, [{ id: "openai-codex/gpt-6-astra", label: "GPT-6 Astra" }, { id: "openai-codex/gpt-6-sol", label: "GPT-6 Sol" }]);
  assert.ok(!JSON.stringify(crew.state()).includes("SECRET-TOKEN"));
  assert.deepEqual(store({ pi: false }).crew.catalog().harnesses[1]!.models, []);
});

test("a model the catalog does not list is kept, saved, described to leads and offered by the picker", () => {
  const { crew } = store();
  const tree = copy(crew.state().tree);
  tree.rules[0]!.use!.model = "claude-opus-5-5";
  tree.rules[1]!.use!.model = "openai-codex/gpt-7-nova";
  const saved = crew.save(tree);
  assert.equal(saved.problem, null);
  assert.equal(saved.tree.rules[0]!.use!.model, "claude-opus-5-5");
  assert.equal(JSON.parse(readFileSync(crew.file, "utf8")).rules[1].use.model, "openai-codex/gpt-7-nova");
  assert.match(crew.text(), /Use: Opus 5\.5, medium effort, in Claude Code\..*\n.*--model claude-opus-5-5 --effort medium/);
  assert.match(crew.text(), /--model openai-codex\/gpt-7-nova:high/);

  const { catalog } = saved;
  const unlisted = modelOptions(catalog, saved.tree.rules[1]!.use!);
  assert.deepEqual(unlisted[0], { id: "openai-codex/gpt-7-nova", label: "GPT-7 Nova (not in the list)", listed: false }, "shown first, by name, as not listed");
  assert.deepEqual(unlisted.slice(1).map((m) => m.id), ["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol"]);
  const fable = modelOptions(catalog, { harness: "claude", model: "fable", effort: "high" });
  assert.ok(fable.every((m) => m.listed), "Fable is in the catalog, so it is not marked unlisted");
  assert.equal(modelOptions(catalog, { harness: "claude", model: "", effort: "high" }).length, 4, "no blank entry from the list itself");
});

test("the printed tree is compact, numbered, and gives every leaf its exact start command", () => {
  const { crew } = store();
  const tree = copy(crew.state().tree);
  tree.rules[0]!.children = [{ id: "ui", when: "UI design\nwith taste", use: { harness: "claude", model: "opus", effort: "high" }, why: "Taste." }];
  crew.save(tree);
  const text = crew.text();
  assert.match(text, /take the first rule whose "when" fits/);
  assert.match(text, /^1\. When: The task needs deep thinking/m);
  assert.match(text, /^ {3}Use: Opus 5\.5, medium effort, in Claude Code\./m);
  assert.match(text, /^ {3}Start: herdr agent start <name> --kind claude --pane "\$P" -- --model opus --effort medium$/m);
  assert.match(text, /^ {3}1\.1\. When: UI design with taste$/m, "a sub-rule is numbered beneath its rule, on one line");
  assert.match(text, /^ {6}Start: herdr agent start <name> --kind claude --pane "\$P" -- --model opus --effort high$/m);
  assert.match(text, /^2\. When: A second model's view helps/m);
  assert.match(text, /Use: GPT-6 Astra, high effort, in Pi/);
  assert.match(text, /^ {3}Start: herdr agent start <name> --kind pi --pane "\$P" -- --model openai-codex\/gpt-6-astra:high$/m);
  assert.match(text, /^Otherwise: Sonnet 5\.5, high effort, in Claude Code\./m);
  assert.equal((text.match(/Start: /g) ?? []).length, 5, "four rules and the fallback");
  assert.ok(text.split("\n").length < 25);
});

test("the endpoints serve the tree and the catalog, and refuse an invalid save without touching the file", async () => {
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(tmp(), "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const none = async () => { throw new Error("not here"); };
  const world = new World(db, { available: () => true, live: () => [], prompt: none, notify: async () => {}, createWorktree: none, startAgent: none, closePane: none, removeWorktree: none }, () => inbox.state());
  const { crew } = store();
  world.crew = crew;
  const port = 49_000 + Math.floor(Math.random() * 900);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { "content-type": "application/json" };
  try {
    const got = await (await fetch(`${base}/api/world/crew-tree`)).json();
    assert.equal(got.tree.rules.length, 3);
    assert.deepEqual(got.catalog.harnesses.map((h: { id: string }) => h.id), ["claude", "pi"]);
    assert.equal(got.file, crew.file);

    const bad = copy(got.tree);
    bad.rules[0].use.harness = "codex";
    const refused = await fetch(`${base}/api/world/crew-tree`, { method: "PUT", headers: json, body: JSON.stringify(bad) });
    assert.equal(refused.status, 422);
    assert.match((await refused.json()).error, /rules\.0\.use\.harness/);

    const good = copy(got.tree);
    good.rules[0].when = "Only the hardest things.";
    const saved = await fetch(`${base}/api/world/crew-tree`, { method: "PUT", headers: json, body: JSON.stringify(good) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).tree.rules[0].when, "Only the hardest things.");

    const said = await (await fetch(`${base}/api/agent/crew`, { method: "POST", headers: json, body: "{}" })).json();
    assert.match(said.text, /Only the hardest things\./);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
