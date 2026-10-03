import { useEffect, useMemo, useRef, useState } from "react";
import { MIXED, modelOptions, newRuleId, validateCrewTree, type CrewCatalog, type CrewChoice, type CrewRule, type CrewTree, type CrewTreeState } from "../../shared/crewtree.ts";
import { api } from "../api.ts";
import "./CrewGuide.css";

type Path = number[];

/** The dotted path validation reports for the rule at `path`. */
const keyOf = (path: Path) => `rules.${path.join(".children.")}`;

/** The list holding the rule at `path`, and its index in it, in a copy of the tree. */
function listAt(tree: CrewTree, path: Path): [CrewRule[], number] {
  let list = tree.rules;
  for (const i of path.slice(0, -1)) list = list[i]!.children!;
  return [list, path[path.length - 1]!];
}

/** A first choice on the given harness, or on the first the catalog lists. */
function firstChoice(catalog: CrewCatalog, harness?: string): CrewChoice {
  const h = catalog.harnesses.find((x) => x.id === harness) ?? catalog.harnesses[0]!;
  return { harness: h.id, model: h.models[0]?.id ?? "", effort: h.efforts.find((e) => e === "medium") ?? h.efforts[0] ?? "" };
}

const otherThan = (catalog: CrewCatalog, harness: string) => catalog.harnesses.find((h) => h.id !== harness)?.id;

/** A choice and its backup, the backup on a harness other than the choice's. */
function firstPair(catalog: CrewCatalog): { use: CrewChoice; backup: CrewChoice } {
  const use = firstChoice(catalog);
  return { use, backup: firstChoice(catalog, otherThan(catalog, use.harness)) };
}

/** A new main choice with its backup, which moves to another harness when the choice moved onto its harness. */
function withUse(catalog: CrewCatalog, use: CrewChoice, backup: CrewChoice): { use: CrewChoice; backup: CrewChoice } {
  return backup.harness !== use.harness ? { use, backup } : { use, backup: firstChoice(catalog, otherThan(catalog, use.harness)) };
}

/** The founder's crew guide: the decision tree project leads follow when they pick each crew member's model. */
export function CrewGuide({ tick, onBack }: { tick: number; onBack: () => void }) {
  const [loaded, setLoaded] = useState<CrewTreeState | null>(null);
  const [draft, setDraft] = useState<CrewTree | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const baseline = useRef("");
  const draftPreset = useRef("");
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
        if (!dirty) {
          baseline.current = JSON.stringify(s.tree);
          draftPreset.current = s.activePreset;
          setDraft(structuredClone(s.tree));
        }
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
  const patch = (path: Path, fields: Partial<CrewRule>) => edit((t) => {
    const [l, i] = listAt(t, path);
    const next = { ...l[i]!, ...fields };
    for (const k of ["use", "backup"] as const) if (next[k] === undefined) delete next[k];
    l[i] = next;
  });
  const move = (path: Path, by: number) => edit((t) => {
    const [l, i] = listAt(t, path);
    const j = i + by;
    if (j >= 0 && j < l.length) [l[i], l[j]] = [l[j]!, l[i]!];
  });
  const remove = (path: Path) => edit((t) => { const [l, i] = listAt(t, path); l.splice(i, 1); if (!l.length && path.length > 1) { const [p, k] = listAt(t, path.slice(0, -1)); delete p[k]!.children; } });
  const add = (parent: Path | null) => edit((t) => {
    const rule: CrewRule = { id: newRuleId(), when: "", ...firstPair(catalog) };
    if (!parent) return void t.rules.push(rule);
    const [l, i] = listAt(t, parent);
    (l[i]!.children ??= []).push(rule);
  });

  // The switch is saved on its own, at once, over the tree as last saved: an unsaved edit stays a draft.
  const setMode = async (mode: string) => {
    if (mode === loaded.tree.mode || switching) return;
    setSwitching(true);
    setFailure(null);
    try {
      const saved = await api.saveCrewTree({ action: "mode", mode });
      setLoaded(saved);
      baseline.current = JSON.stringify({ ...JSON.parse(baseline.current), mode: saved.tree.mode });
      setDraft((d) => (d ? { ...d, mode: saved.tree.mode } : d));
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setSwitching(false);
    }
  };
  const harnessLabel = (id: string) => catalog.harnesses.find((h) => h.id === id)?.label ?? id;
  const modes = [{ id: MIXED, label: "Mixed" }, ...catalog.harnesses.map((h) => ({ id: h.id, label: `${h.label} only` }))];
  const explain = loaded.tree.mode === MIXED
    ? "Each rule starts its main choice. Its backup waits for the day a harness runs out."
    : `Every new crew member and project lead starts on ${harnessLabel(loaded.tree.mode)}: each rule's main choice or its backup, whichever runs there. Leads are told never to start ${catalog.harnesses.filter((h) => h.id !== loaded.tree.mode).map((h) => h.label).join(" or ")}. Agents already running are not stopped.`;

  const save = async () => {
    setShowErrors(true);
    if (problems.length) return;
    setSaving(true);
    setFailure(null);
    try {
      const saved = await api.saveCrewTree({ action: "edit", presetId: draftPreset.current, tree: draft });
      setLoaded(saved);
      baseline.current = JSON.stringify(saved.tree);
      draftPreset.current = saved.activePreset;
      setDraft(structuredClone(saved.tree));
      setShowErrors(false);
      setSavedAt(Date.now());
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const active = loaded.presets.find((p) => p.id === loaded.activePreset)!;
  const editing = loaded.presets.find((p) => p.id === draftPreset.current);
  const busy = saving || switching;
  const selectPreset = async (presetId: string) => {
    if (busy || dirty || presetId === loaded.activePreset) return;
    setSwitching(true);
    setFailure(null);
    try {
      const saved = await api.saveCrewTree({ action: "select", presetId });
      setLoaded(saved);
      baseline.current = JSON.stringify(saved.tree);
      draftPreset.current = saved.activePreset;
      setDraft(structuredClone(saved.tree));
      setSavedAt(null);
      setShowErrors(false);
    } catch (err) { setFailure((err as Error).message); }
    finally { setSwitching(false); }
  };
  const discard = () => {
    baseline.current = JSON.stringify(loaded.tree);
    draftPreset.current = loaded.activePreset;
    setDraft(structuredClone(loaded.tree));
    setShowErrors(false);
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
            {rule.use && rule.backup ? (
              <Pair value={{ use: rule.use, backup: rule.backup }} catalog={catalog} mode={draft.mode} errors={(f) => errorAt(`${key}.${f}`)} onChange={(p) => patch(path, p)} />
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
                  ? <button className="ghost small" title="Let the sub-rules alone decide" onClick={() => patch(path, { use: undefined, backup: undefined })}>No choice of its own</button>
                  : <button className="ghost small" onClick={() => patch(path, firstPair(catalog))}>Give it a choice</button>
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
        <button className="primary small" disabled={busy || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </header>
      {loaded.problem ? <p className="warn">{loaded.problem}</p> : null}
      {failure ? <p className="warn">{failure}</p> : null}
      {showErrors && problems.length ? <p className="warn">{problems.length === 1 ? "One thing needs fixing" : `${problems.length} things need fixing`} before this can be saved.</p> : null}
      {savedAt && !dirty ? <p className="board-note">Saved. Leads read the new guide the next time they look at it.</p> : null}
      <section className="crew-switch crew-presets" aria-label="Guide presets">
        <h2>Active preset: {active.name}</h2>
        <p className="muted small-note">Switch the whole guide in one click. Your harness switch below always applies on top.</p>
        <div className="crew-preset-grid" role="radiogroup" aria-label="Guide preset">
          {loaded.presets.map((p) => <button key={p.id} role="radio" aria-checked={p.id === loaded.activePreset}
            disabled={busy || dirty} className={`crew-preset${p.id === loaded.activePreset ? " on" : ""}`} onClick={() => void selectPreset(p.id)}>
            <strong>{p.name}{p.id === loaded.activePreset ? " · Active" : ""}</strong><span>{p.description}</span>
          </button>)}
        </div>
        <p className="muted small-note">{editing?.builtin ? `Editing ${editing.name}? Save creates your own copy; the built-in and My guide stay untouched.` : "Your saved guide stays here when you try a built-in preset."}</p>
        {dirty ? <p className="crew-draft-note" role="status">Unsaved edits to {editing?.name}. Save or <button className="ghost small" disabled={busy} onClick={discard}>Discard edits</button> before switching presets.</p> : null}
      </section>
      <section className="crew-switch" aria-label="Which harness the crew runs on">
        <h2>Which harness runs the crew</h2>
        <div className="crew-modes" role="radiogroup">
          {modes.map((m) => (
            <button key={m.id} role="radio" aria-checked={loaded.tree.mode === m.id} className={`crew-mode${loaded.tree.mode === m.id ? " on" : ""}`} disabled={busy} onClick={() => void setMode(m.id)}>{m.label}</button>
          ))}
        </div>
        <p className="muted small-note">{explain}</p>
      </section>
      <fieldset className="crew-editor" disabled={busy}>
      <section className="crew-rule crew-lead">
        <h2>Project lead</h2>
        <p className="muted small-note">What a new project's first mate runs on.</p>
        <Pair value={draft.lead} catalog={catalog} mode={draft.mode} errors={(f) => errorAt(`lead.${f}`)} onChange={(p) => edit((t) => void (t.lead = { ...t.lead, ...p }))} />
        <label className="field">
          <span>Why</span>
          <input value={draft.lead.why ?? ""} placeholder="One line" onChange={(e) => edit((t) => void (t.lead.why = e.target.value))} />
        </label>
      </section>
      {renderRules(draft.rules, [])}
      <button className="ghost small crew-add" onClick={() => add(null)}>+ Add a rule</button>
      <section className="crew-rule crew-fallback">
        <h2>Otherwise</h2>
        <p className="muted small-note">When no rule above fits.</p>
        <Pair value={{ use: draft.fallback, backup: draft.fallback.backup }} catalog={catalog} mode={draft.mode} errors={(f) => errorAt(`fallback.${f.replace(/^use\./, "")}`)} onChange={(p) => edit((t) => void (t.fallback = { ...p.use, backup: p.backup, why: t.fallback.why }))} />
        <label className="field">
          <span>Why</span>
          <input value={draft.fallback.why ?? ""} placeholder="One line" onChange={(e) => edit((t) => void (t.fallback.why = e.target.value))} />
        </label>
      </section>
      </fieldset>
    </main>
  );
}

/** A main choice and its backup, the backup limited to the other harnesses; the one the founder's switch has turned off is dimmed. */
function Pair({ value, catalog, mode, errors, onChange }: { value: { use: CrewChoice; backup: CrewChoice }; catalog: CrewCatalog; mode: string; errors: (path: string) => string | undefined; onChange: (p: { use: CrewChoice; backup: CrewChoice }) => void }) {
  const off = (c: CrewChoice) => mode !== MIXED && c.harness !== mode;
  return (
    <div className="crew-pair">
      <Picker title="Main" off={off(value.use)} value={value.use} catalog={catalog} errors={(f) => errors(`use.${f}`)} onChange={(use) => onChange(withUse(catalog, use, value.backup))} />
      <Picker title="Backup" off={off(value.backup)} value={value.backup} avoid={value.use.harness} catalog={catalog} errors={(f) => errors(`backup.${f}`)} onChange={(backup) => onChange({ use: value.use, backup })} />
    </div>
  );
}

/** Harness, model and effort, each from the catalog the service supplies; `avoid` leaves one harness out of the choices. */
function Picker({ title, off, value, avoid, catalog, errors, onChange }: { title: string; off: boolean; value: CrewChoice; avoid?: string; catalog: CrewCatalog; errors: (field: string) => string | undefined; onChange: (c: CrewChoice) => void }) {
  const harness = catalog.harnesses.find((h) => h.id === value.harness);
  const setHarness = (id: string) => {
    const h = catalog.harnesses.find((x) => x.id === id)!;
    onChange({
      harness: id,
      model: h.models[0]?.id ?? "",
      effort: h.efforts.includes(value.effort) ? value.effort : h.efforts.find((e) => e === "medium") ?? h.efforts[0] ?? "",
    });
  };
  return (
    <div className={`crew-pick${off ? " crew-off" : ""}`}>
      <span className="crew-pick-title">{title}{off ? <em> · switched off</em> : null}</span>
      <div className="crew-picker">
      <label className="field">
        <span>Harness</span>
        <select value={value.harness} onChange={(e) => setHarness(e.target.value)}>
          {harness ? null : <option value={value.harness}>{value.harness} (unknown)</option>}
          {catalog.harnesses.filter((h) => h.id !== avoid).map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
        {errors("harness") ? <em className="crew-error">{errors("harness")}</em> : null}
      </label>
      <label className="field">
        <span>Model</span>
        {harness && !harness.models.length ? (
          <input value={value.model} placeholder="model id" onChange={(e) => onChange({ ...value, model: e.target.value })} />
        ) : (
          <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} title={value.model}>
            {value.model ? null : <option value="">Choose a model</option>}
            {modelOptions(catalog, value).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
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
    </div>
  );
}
