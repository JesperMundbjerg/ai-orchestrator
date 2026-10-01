import { useEffect, useMemo, useRef, useState } from "react";
import { newRuleId, validateCrewTree, type CrewCatalog, type CrewChoice, type CrewRule, type CrewTree, type CrewTreeState } from "../../shared/crewtree.ts";
import { api } from "../api.ts";

type Path = number[];

/** The dotted path validation reports for the rule at `path`. */
const keyOf = (path: Path) => `rules.${path.join(".children.")}`;

/** The list holding the rule at `path`, and its index in it, in a copy of the tree. */
function listAt(tree: CrewTree, path: Path): [CrewRule[], number] {
  let list = tree.rules;
  for (const i of path.slice(0, -1)) list = list[i]!.children!;
  return [list, path[path.length - 1]!];
}

function firstChoice(catalog: CrewCatalog): CrewChoice {
  const h = catalog.harnesses[0]!;
  return { harness: h.id, model: h.models[0]?.id ?? "", effort: h.efforts.find((e) => e === "medium") ?? h.efforts[0] ?? "" };
}

/** The founder's crew guide: the decision tree project leads follow when they pick each crew member's model. */
export function CrewGuide({ tick, onBack }: { tick: number; onBack: () => void }) {
  const [loaded, setLoaded] = useState<CrewTreeState | null>(null);
  const [draft, setDraft] = useState<CrewTree | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const baseline = useRef("");
  const draftRef = useRef<CrewTree | null>(null);
  draftRef.current = draft;

  // The tree is read again when the service reports a change, unless there is an unsaved edit to protect.
  useEffect(() => {
    let live = true;
    api.crewTree().then(
      (s) => {
        if (!live) return;
        setLoaded(s);
        const dirty = draftRef.current && JSON.stringify(draftRef.current) !== baseline.current;
        baseline.current = JSON.stringify(s.tree);
        if (!dirty) setDraft(structuredClone(s.tree));
      },
      (e: Error) => live && setFailure(e.message),
    );
    return () => {
      live = false;
    };
  }, [tick]);

  const problems = useMemo(() => (draft && loaded ? validateCrewTree(draft, loaded.catalog) : []), [draft, loaded]);
  if (!draft || !loaded) return <main className="board crew-guide"><p className="muted">{failure ? `The office did not answer (${failure}).` : "Loading…"}</p></main>;

  const { catalog } = loaded;
  const dirty = JSON.stringify(draft) !== baseline.current;
  const errorAt = (path: string) => (showErrors ? problems.find((p) => p.path === path)?.message : undefined);
  const edit = (fn: (tree: CrewTree) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
    setSavedAt(null);
  };
  const patch = (path: Path, fields: Partial<CrewRule>) => edit((t) => { const [l, i] = listAt(t, path); l[i] = { ...l[i]!, ...fields }; });
  const move = (path: Path, by: number) => edit((t) => {
    const [l, i] = listAt(t, path);
    const j = i + by;
    if (j >= 0 && j < l.length) [l[i], l[j]] = [l[j]!, l[i]!];
  });
  const remove = (path: Path) => edit((t) => { const [l, i] = listAt(t, path); l.splice(i, 1); if (!l.length && path.length > 1) { const [p, k] = listAt(t, path.slice(0, -1)); delete p[k]!.children; } });
  const add = (parent: Path | null) => edit((t) => {
    const rule: CrewRule = { id: newRuleId(), when: "", use: firstChoice(catalog) };
    if (!parent) return void t.rules.push(rule);
    const [l, i] = listAt(t, parent);
    (l[i]!.children ??= []).push(rule);
  });

  const save = async () => {
    setShowErrors(true);
    if (problems.length) return;
    setSaving(true);
    setFailure(null);
    try {
      const saved = await api.saveCrewTree(draft);
      setLoaded(saved);
      baseline.current = JSON.stringify(saved.tree);
      setDraft(structuredClone(saved.tree));
      setShowErrors(false);
      setSavedAt(Date.now());
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // A function, not a component: a component defined here would be remade on each keystroke and lose the focus.
  const renderRules = (rules: CrewRule[], parent: Path) => (
    <ol className="crew-rules">
      {rules.map((rule, i) => {
        const path = [...parent, i];
        const key = keyOf(path);
        return (
          <li key={rule.id} className="crew-rule">
            <div className="crew-rule-head">
              <span className="crew-n">{path.map((n) => n + 1).join(".")}</span>
              <label className="field crew-when">
                <span>When</span>
                <textarea rows={2} value={rule.when} placeholder="Describe the tasks this rule is for" onChange={(e) => patch(path, { when: e.target.value })} aria-invalid={Boolean(errorAt(`${key}.when`))} />
                {errorAt(`${key}.when`) ? <em className="crew-error">{errorAt(`${key}.when`)}</em> : null}
              </label>
            </div>
            {rule.use ? (
              <Picker value={rule.use} catalog={catalog} errors={(f) => errorAt(`${key}.use.${f}`)} onChange={(use) => patch(path, { use })} />
            ) : (
              <p className="muted small-note">No choice of its own: only its sub-rules decide. {errorAt(`${key}.use`) ? <em className="crew-error">{errorAt(`${key}.use`)}</em> : null}</p>
            )}
            <label className="field">
              <span>Why</span>
              <input value={rule.why ?? ""} placeholder="One line the leads and you see" onChange={(e) => patch(path, { why: e.target.value })} />
            </label>
            {errorAt(`${key}.id`) ? <em className="crew-error">{errorAt(`${key}.id`)}</em> : null}
            <div className="crew-actions">
              <button className="ghost small" disabled={i === 0} onClick={() => move(path, -1)} aria-label="Move up">↑</button>
              <button className="ghost small" disabled={i === rules.length - 1} onClick={() => move(path, 1)} aria-label="Move down">↓</button>
              <button className="ghost small" onClick={() => add(path)}>+ Sub-rule</button>
              {rule.children?.length ? (
                rule.use
                  ? <button className="ghost small" title="Let the sub-rules alone decide" onClick={() => patch(path, { use: undefined })}>No choice of its own</button>
                  : <button className="ghost small" onClick={() => patch(path, { use: firstChoice(catalog) })}>Give it a choice</button>
              ) : null}
              <span className="spacer" />
              <button className="ghost small danger" onClick={() => remove(path)}>Remove</button>
            </div>
            {rule.children?.length ? renderRules(rule.children, path) : null}
          </li>
        );
      })}
    </ol>
  );

  return (
    <main className="board crew-guide">
      <header className="board-head row">
        <div>
          <h1>Crew guide</h1>
          <p className="muted">How a project's first mate chooses each crew member's model. They read it top to bottom and take the first rule whose “when” fits the task; a rule with sub-rules narrows further. Nothing decides for them. Kept in <code>{loaded.file}</code>, which you can also edit by hand.</p>
        </div>
        <span className="spacer" />
        <button className="ghost small" onClick={onBack}>← Projects</button>
        <button className="primary small" disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </header>
      {loaded.problem ? <p className="warn">{loaded.problem}</p> : null}
      {failure ? <p className="warn">{failure}</p> : null}
      {showErrors && problems.length ? <p className="warn">{problems.length === 1 ? "One thing needs fixing" : `${problems.length} things need fixing`} before this can be saved.</p> : null}
      {savedAt && !dirty ? <p className="board-note">Saved. Leads read the new guide the next time they look at it.</p> : null}
      {renderRules(draft.rules, [])}
      <button className="ghost small crew-add" onClick={() => add(null)}>+ Add a rule</button>
      <section className="crew-rule crew-fallback">
        <h2>Otherwise</h2>
        <p className="muted small-note">When no rule above fits.</p>
        <Picker value={draft.fallback} catalog={catalog} errors={(f) => errorAt(`fallback.${f}`)} onChange={(c) => edit((t) => void (t.fallback = { ...c, why: t.fallback.why }))} />
        <label className="field">
          <span>Why</span>
          <input value={draft.fallback.why ?? ""} placeholder="One line" onChange={(e) => edit((t) => void (t.fallback.why = e.target.value))} />
        </label>
      </section>
    </main>
  );
}

/** Harness, model and effort, each from the catalog the service supplies. */
function Picker({ value, catalog, errors, onChange }: { value: CrewChoice; catalog: CrewCatalog; errors: (field: string) => string | undefined; onChange: (c: CrewChoice) => void }) {
  const harness = catalog.harnesses.find((h) => h.id === value.harness);
  const known = harness?.models.some((m) => m.id === value.model);
  const setHarness = (id: string) => {
    const h = catalog.harnesses.find((x) => x.id === id)!;
    onChange({
      harness: id,
      model: h.models[0]?.id ?? "",
      effort: h.efforts.includes(value.effort) ? value.effort : h.efforts.find((e) => e === "medium") ?? h.efforts[0] ?? "",
    });
  };
  return (
    <div className="crew-picker">
      <label className="field">
        <span>Harness</span>
        <select value={value.harness} onChange={(e) => setHarness(e.target.value)}>
          {harness ? null : <option value={value.harness}>{value.harness} (unknown)</option>}
          {catalog.harnesses.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
        {errors("harness") ? <em className="crew-error">{errors("harness")}</em> : null}
      </label>
      <label className="field">
        <span>Model</span>
        {harness && !harness.models.length ? (
          <input value={value.model} placeholder="model id" onChange={(e) => onChange({ ...value, model: e.target.value })} />
        ) : (
          <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {known ? null : <option value={value.model}>{value.model || "Choose a model"}{value.model ? " (not in the list)" : ""}</option>}
            {harness?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        {errors("model") ? <em className="crew-error">{errors("model")}</em> : null}
      </label>
      <label className="field">
        <span>Effort</span>
        <select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
          {harness?.efforts.includes(value.effort) ? null : <option value={value.effort}>{value.effort || "Choose"}</option>}
          {harness?.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        {errors("effort") ? <em className="crew-error">{errors("effort")}</em> : null}
      </label>
    </div>
  );
}
