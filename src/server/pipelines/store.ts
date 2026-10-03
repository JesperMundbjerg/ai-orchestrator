import type { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { PipelineAbandonInput, PipelineAssignInput, PipelineBranchInput, PipelineDoneInput, PipelineEvidence, PipelineEvidenceInput, PipelineGateInput, PipelineGateResult, PipelineGraph, PipelineLayoutInput, PipelineOverrideInput, PipelinePalette, PipelineReportInput, PipelineRun, PipelineStartInput, PipelineStatus, PipelineTeamView } from "../../shared/pipeline.ts";
import type { Team, WorldAgent, WorldState } from "../../shared/types.ts";
import { InboxError } from "../inbox.ts";
import { dataDir, requestFingerprint } from "../db.ts";
import { Adapters } from "../adapter.ts";
import { activation, pathProblems, policyHash, selected, topological, validateGraph, validateLayout } from "./model.ts";
import { BUILTINS, discover, within } from "./discovery.ts";
import { capture, repository, sameCandidate } from "./candidate.ts";

type Config = { team_id: string; repo_root: string | null; graph: string | null; layout: string; revision: number; layout_revision: number; protected: number; observed_hash: string | null };
export class Pipelines {
  private db: DatabaseSync;
  private world: () => WorldState;
  private evidenceDir: string;
  private now: () => Date;
  private changed: () => void;
  private adapters = new Adapters();
  constructor(db: DatabaseSync, world: () => WorldState, options: { evidenceDir?: string; now?: () => Date; changed?: () => void } = {}) {
    this.db = db; this.world = world; this.evidenceDir = options.evidenceDir ?? join(dataDir(), "pipeline-evidence");
    this.now = options.now ?? (() => new Date()); this.changed = options.changed ?? (() => {});
  }
  private context(teamId: string): { team: Team; state: WorldState; lead: WorldAgent | null } {
    const state = this.world(); const team = state.teams.find(t => t.id === teamId);
    if (!team) throw new InboxError(404, "pipeline team no longer exists");
    return { team, state, lead: state.agents.find(a => a.teamId === teamId && a.role === "lead") ?? null };
  }
  private lead(actor: WorldAgent, teamId: string): void {
    if (this.context(teamId).lead?.id !== actor.id) throw new InboxError(403, "Only the current first mate can select branches, complete steps, abandon runs or deliver; report to your lead.", "pipeline_lead_required");
  }
  private config(teamId: string): Config {
    this.db.prepare("INSERT OR IGNORE INTO team_pipelines (team_id) VALUES (?)").run(teamId);
    return this.db.prepare("SELECT * FROM team_pipelines WHERE team_id = ?").get(teamId) as unknown as Config;
  }
  private binding(teamId: string, config: Config): { root: string | null; problems: string[] } {
    const { team, state, lead } = this.context(teamId);
    if (config.repo_root) { try { return { root: repository(config.repo_root).root, problems: [] }; } catch { return { root: config.repo_root, problems: ["Bound repository is unavailable."] }; } }
    const paths = team.path ? [team.path] : [...team.worktrees, ...(lead?.cwd ? [lead.cwd] : []), ...state.agents.filter(a => a.teamId === teamId && a.cwd).map(a => a.cwd!)];
    const roots = new Set<string>();
    for (const path of paths) try { roots.add(repository(path).root); } catch { /* disappearing/offline checkouts do not invent a binding */ }
    return roots.size === 1 ? { root: [...roots][0]!, problems: [] } : { root: null, problems: roots.size ? ["Team spans repositories; choose an explicit repository binding."] : ["Team has no available repository checkout."] };
  }
  teamView(teamId: string): PipelineTeamView {
    this.context(teamId); const config = this.config(teamId); const binding = this.binding(teamId, config);
    const problems = [...binding.problems]; let graph: PipelineGraph | null = null;
    let source: PipelineTeamView["source"] = "none";
    // Compatibility is read-only: new saves still reject orphan fields.
    if (config.graph) { graph = validateGraph(JSON.parse(config.graph), { allowUnreferencedFields: true }); source = "team"; }
    else if (binding.root && !binding.problems.length) {
      const result = this.adapters.read(binding.root, basename(binding.root));
      problems.push(...result.problems);
      if (result.adapter?.pipeline) { graph = result.adapter.pipeline; source = "repo"; }
    }
    const hash = graph ? policyHash(graph) : null;
    // A previously observed default cannot silently disappear and turn delivery off.
    if (graph && (hash !== config.observed_hash || !config.protected)) {
      const bump = !config.graph && config.observed_hash !== null && hash !== config.observed_hash ? 1 : 0;
      this.db.prepare("UPDATE team_pipelines SET observed_hash = ?, protected = 1, revision = revision + ? WHERE team_id = ?").run(hash, bump, teamId);
      config.revision += bump;
    }
    const protectedTeam = Boolean(config.protected || graph);
    if (protectedTeam && !graph) problems.push("Protected pipeline is missing; founder must explicitly reset or repair it.");
    const palette = binding.root && !binding.problems.length ? discover(binding.root) : { entries: BUILTINS, problems: [] };
    problems.push(...palette.problems);
    if (graph) for (const n of graph.nodes) if (n.source && !palette.entries.some(d => d.id === n.source)) problems.push(`${n.label}: source ${n.source} is unavailable`);
    const layout = { ...(graph?.positions ?? {}), ...JSON.parse(config.layout) };
    return { teamId, repoRoot: binding.root, source, graph, revision: config.revision, layoutRevision: config.layout_revision, policyHash: hash, layout, problems: [...new Set(problems)], protected: protectedTeam, runs: this.list(teamId) };
  }
  palette(teamId: string): PipelinePalette {
    const config = this.config(teamId); const b = this.binding(teamId, config);
    const result = b.root && !b.problems.length ? discover(b.root) : { entries: BUILTINS, problems: [] };
    return { teamId, repoRoot: b.root, entries: result.entries, problems: [...b.problems, ...result.problems] };
  }
  saveOverride(teamId: string, input: PipelineOverrideInput): PipelineTeamView {
    const graph = input.graph === null ? null : validateGraph(input.graph);
    return this.atomic(() => {
      this.context(teamId); const config = this.config(teamId);
      if (config.revision !== input.expectedRevision) throw new InboxError(409, "pipeline changed; reload before saving", "pipeline_revision_conflict");
      const repo = input.repoRoot ? repository(input.repoRoot).root : config.repo_root;
      this.db.prepare("UPDATE team_pipelines SET graph = ?, repo_root = ?, revision = revision + 1, protected = ?, observed_hash = ? WHERE team_id = ?")
        .run(graph ? JSON.stringify(graph) : null, repo, graph ? 1 : 0, graph ? policyHash(graph) : null, teamId);
      return this.teamView(teamId);
    });
  }
  saveLayout(teamId: string, input: PipelineLayoutInput): PipelineTeamView {
    const positions = validateLayout(input.positions);
    return this.atomic(() => {
      const view = this.teamView(teamId);
      if (view.layoutRevision !== input.expectedRevision) throw new InboxError(409, "pipeline layout changed; reload before saving", "pipeline_layout_conflict");
      if (!view.graph || Object.keys(positions).some(k => !view.graph!.nodes.some(n => n.id === k))) throw new InboxError(422, "layout references a missing node");
      this.db.prepare("UPDATE team_pipelines SET layout = ?, layout_revision = layout_revision + 1 WHERE team_id = ?").run(JSON.stringify(positions), teamId);
      return this.teamView(teamId);
    });
  }
  private raw(id: string): PipelineRun {
    const row = this.db.prepare("SELECT snapshot FROM pipeline_runs WHERE id = ?").get(id);
    if (!row) throw new InboxError(404, `no pipeline run ${id}`);
    return JSON.parse(String(row.snapshot)) as PipelineRun;
  }
  get(id: string): PipelineRun {
    const run = this.raw(id); run.leadId = this.context(run.teamId).lead?.id ?? null;
    if (run.state === "abandoned") return run;
    const { active, edges } = activation(run.graph, run.selections);
    const fresh = run.state === "delivered" || sameCandidate(run.candidate);
    for (const key of topological(run.graph)) {
      const step = run.steps.find(s => s.nodeId === key)!; const node = run.graph.nodes.find(n => n.id === key)!;
      if (!active.has(key)) { step.state = "inactive"; continue; }
      if (step.completedBy) { step.state = fresh && step.evidence.every(e => e.fingerprint === run.candidate.fingerprint && e.round === run.round) ? "done" : "stale"; continue; }
      const currentEvidence = fresh && step.evidence.some(e => e.fingerprint === run.candidate.fingerprint && e.round === run.round);
      // Retained history is not an endorsable report, even after branch() clears completion.
      if (step.evidence.length && !currentEvidence) { step.state = "stale"; continue; }
      const parents = run.graph.edges.filter(e => e.to === key && edges.has(e.id)).map(e => run.steps.find(s => s.nodeId === e.from)!);
      if (parents.some(p => p.state !== "done")) step.state = "blocked";
      else if (node.kind === "condition") step.state = Object.hasOwn(run.selections, node.field!) ? "done" : "blocked";
      else if (node.kind === "delivery") step.state = run.state === "delivered" ? "done" : "ready";
      else step.state = currentEvidence ? "reported" : "ready";
    }
    return run;
  }
  list(teamId: string): PipelineRun[] {
    return this.db.prepare("SELECT id FROM pipeline_runs WHERE team_id = ? ORDER BY created_at DESC LIMIT 30").all(teamId).map(r => this.get(String(r.id)));
  }
  private persist(run: PipelineRun): PipelineRun {
    run.updatedAt = this.now().toISOString(); run.revision++;
    this.db.prepare("INSERT INTO pipeline_runs (id, team_id, snapshot, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot")
      .run(run.id, run.teamId, JSON.stringify(run), run.createdAt);
    return this.get(run.id);
  }
  private replay<T>(actor: WorldAgent, operation: string, input: { clientId: string }, fn: () => T): T {
    if (!input.clientId?.trim()) throw new InboxError(400, "pipeline mutation needs a clientId");
    const fingerprint = requestFingerprint([actor.id, operation, input]);
    return this.atomic(() => {
      const earlier = this.db.prepare("SELECT fingerprint, result FROM pipeline_requests WHERE client_id = ?").get(input.clientId);
      if (earlier) {
        if (earlier.fingerprint !== fingerprint) throw new InboxError(409, "clientId was used for another pipeline request", "replay_conflict");
        return JSON.parse(String(earlier.result)) as T;
      }
      const result = fn();
      this.db.prepare("INSERT INTO events (at, actor, task_id, item_id, kind, detail) VALUES (?, 'agent', NULL, NULL, ?, ?)")
        .run(this.now().toISOString(), `pipeline.${operation}`, JSON.stringify({ agentId: actor.id, clientId: input.clientId, request: input }));
      this.db.prepare("INSERT INTO pipeline_requests (client_id, fingerprint, result) VALUES (?, ?, ?)").run(input.clientId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  start(actor: WorldAgent, input: PipelineStartInput): PipelineRun {
    return this.replay(actor, "start", input, () => {
      if (!actor.teamId) throw new InboxError(409, "join a team before starting a pipeline");
      this.lead(actor, actor.teamId); const view = this.teamView(actor.teamId);
      if (!view.graph || !view.repoRoot) throw new InboxError(409, "no usable pipeline; configure the team graph and repository first");
      const checkout = input.checkout ?? actor.cwd ?? view.repoRoot;
      const candidate = capture(checkout, input.base ?? "HEAD", input.candidate ?? "HEAD");
      if (repository(candidate.checkout).common !== repository(view.repoRoot).common) throw new InboxError(403, "candidate belongs to another repository");
      const { team, state } = this.context(actor.teamId);
      const owned = [team.path, ...team.worktrees, ...state.agents.filter(a => a.teamId === actor.teamId).map(a => a.cwd)].filter((p): p is string => Boolean(p));
      if (!owned.some(p => { try { return repository(p).top === candidate.checkout; } catch { return false; } })) throw new InboxError(403, "use a checkout owned by this team");
      if (input.workId) this.checkWork(input.workId, input.workRound, actor.teamId, candidate.fingerprint);
      const definitions = Object.fromEntries(this.palette(actor.teamId).entries.map(d => [d.id, d.hash]));
      const at = this.now().toISOString();
      const run: PipelineRun = { id: randomUUID(), teamId: actor.teamId, leadId: actor.id, graph: view.graph, policyHash: view.policyHash!, definitionHashes: definitions, revision: 0, round: 1, candidate,
        selections: {}, rationale: "", steps: view.graph.nodes.map(n => ({ nodeId: n.id, state: "inactive", assignedTo: null, completedBy: null, evidence: [], notes: "" })), state: "open", workId: input.workId ?? null, workRound: input.workRound ?? null, createdAt: at, updatedAt: at };
      return this.persist(run);
    });
  }
  private editable(actor: WorldAgent, runId: string, expectedRevision: number, lead = true): PipelineRun {
    const run = this.raw(runId);
    if (lead) this.lead(actor, run.teamId);
    else if (actor.teamId !== run.teamId) throw new InboxError(403, "only this team's crew may report pipeline evidence");
    if (run.state !== "open") throw new InboxError(409, `pipeline run is already ${run.state}`);
    if (run.revision !== expectedRevision) throw new InboxError(409, "run changed; refresh status before editing", "pipeline_revision_conflict");
    return run;
  }
  branch(actor: WorldAgent, input: PipelineBranchInput): PipelineRun {
    return this.replay(actor, "branch", input, () => {
      const run = this.editable(actor, input.runId, input.expectedRevision);
      if (!input.rationale.trim()) throw new InboxError(400, "record why these branches apply");
      const choices = { ...run.selections, ...input.selections }; const problems = selected(run.graph, choices);
      if (problems.length) throw new InboxError(422, problems.join("; "));
      if (input.candidate) {
        const next = capture(run.candidate.checkout, run.candidate.base, input.candidate);
        if (next.fingerprint !== run.candidate.fingerprint) { run.round++; run.steps.forEach(s => { s.completedBy = null; }); }
        run.candidate = next;
      }
      const paths = pathProblems(run.graph, choices, run.candidate.changedPaths);
      if (paths.length) throw new InboxError(422, paths.join("; "), "pipeline_branch_conflict");
      if (JSON.stringify(choices) !== JSON.stringify(run.selections)) run.steps.forEach(s => { s.completedBy = null; });
      run.selections = choices; run.rationale = input.rationale;
      return this.persist(run);
    });
  }
  abandon(actor: WorldAgent, input: PipelineAbandonInput): PipelineRun {
    // Even receipt retrieval is restricted to the team's current first mate.
    this.lead(actor, this.raw(input.runId).teamId);
    return this.replay(actor, "abandon", input, () => {
      const run = this.get(input.runId);
      this.lead(actor, run.teamId);
      if (run.state !== "open") throw new InboxError(409, `pipeline run is already ${run.state}`);
      if (!input.notes?.trim()) throw new InboxError(400, "record why this run will not be delivered");
      run.state = "abandoned";
      run.abandonment = { notes: input.notes.trim(), byAgentId: actor.id, at: this.now().toISOString() };
      return this.persist(run);
    });
  }
  assign(actor: WorldAgent, input: PipelineAssignInput): PipelineRun {
    return this.replay(actor, "assign", input, () => {
      const run = this.editable(actor, input.runId, input.expectedRevision); const step = run.steps.find(s => s.nodeId === input.nodeId);
      if (!step) throw new InboxError(404, "no such pipeline step");
      if (!this.context(run.teamId).state.agents.some(a => a.id === input.agentId && a.teamId === run.teamId)) throw new InboxError(403, "assign a member of this team");
      step.assignedTo = input.agentId; return this.persist(run);
    });
  }
  report(actor: WorldAgent, input: PipelineReportInput): PipelineRun { return this.record(actor, input, false); }
  done(actor: WorldAgent, input: PipelineDoneInput): PipelineRun { return this.record(actor, input, true); }
  private record(actor: WorldAgent, input: PipelineDoneInput, done: boolean): PipelineRun {
    const created: string[] = [];
    try { return this.replay(actor, done ? "done" : "report", input, () => {
      const run = this.editable(actor, input.runId, input.expectedRevision, done);
      const live = this.get(run.id); const step = run.steps.find(s => s.nodeId === input.nodeId); const status = live.steps.find(s => s.nodeId === input.nodeId);
      const node = run.graph.nodes.find(n => n.id === input.nodeId);
      if (!step || !node || !status) throw new InboxError(404, "no such pipeline step");
      if (!["step", "approval"].includes(node.kind)) throw new InboxError(409, "conditions are selected with branch; delivery completes only at its boundary");
      const { edges } = activation(run.graph, run.selections);
      const blocked = run.graph.edges.some(e => e.to === node.id && edges.has(e.id) && live.steps.find(s => s.nodeId === e.from)?.state !== "done");
      if (!["ready", "reported", "stale"].includes(status.state) || blocked || !sameCandidate(run.candidate)) throw new InboxError(409, "step is inactive, blocked or candidate is stale", "pipeline_step_blocked");
      if (!done && actor.id !== live.leadId && step.assignedTo !== actor.id) throw new InboxError(403, "report only your assigned step");
      if (!input.notes?.trim()) throw new InboxError(400, "record the result or lead disposition");
      const additions = (input.evidence ?? []).map(e => this.evidence(actor, run, e, created));
      if (done) {
        const ids = input.evidenceIds ?? step.evidence.filter(e => e.round === run.round && e.fingerprint === run.candidate.fingerprint).map(e => e.id);
        if (ids.some(id => !step.evidence.some(e => e.id === id))) throw new InboxError(422, "evidence id does not belong to this step");
        const endorsed = [...step.evidence.filter(e => ids.includes(e.id)), ...additions];
        if ((node.evidence ?? []).some(kind => !endorsed.some(e => e.kind === kind && e.round === run.round && e.fingerprint === run.candidate.fingerprint))) throw new InboxError(409, "required evidence is missing or stale", "pipeline_evidence_required");
        step.evidence = endorsed; step.completedBy = actor.id;
      } else step.evidence.push(...additions);
      step.notes = input.notes; return this.persist(run);
    }); } catch (err) { for (const file of created) try { unlinkSync(file); } catch { /* transaction rolled back; cleanup only our copied files */ } throw err; }
  }
  private evidence(actor: WorldAgent, run: PipelineRun, input: PipelineEvidenceInput, created: string[]): PipelineEvidence {
    if (!input.summary?.trim() || !["report", "check", "artifact", "review", "approval"].includes(input.kind)) throw new InboxError(422, "evidence needs a kind and non-empty summary");
    if (input.kind === "check" && (!input.command?.trim() || input.exitCode !== 0)) throw new InboxError(409, "check evidence needs its command and successful exit code");
    if (input.kind === "review") {
      const r = input.review; if (!r) throw new InboxError(422, "review evidence needs work id and round");
      const work = this.db.prepare("SELECT * FROM work WHERE id = ?").get(r.workId);
      const binding = this.db.prepare("SELECT fingerprint FROM pipeline_work_bindings WHERE work_id = ? AND round = ?").get(r.workId, r.round);
      if (!work || work.state !== "accepted" || work.round !== r.round || binding?.fingerprint !== run.candidate.fingerprint) throw new InboxError(409, "review verdict is missing, stale or not bound to this candidate");
    }
    if (input.kind === "approval") {
      const a = input.approval; if (!a) throw new InboxError(422, "approval needs item id and revision");
      const item = this.db.prepare("SELECT revision, type, state FROM items WHERE id = ?").get(a.itemId);
      const accept = this.db.prepare("SELECT id, action, state FROM replies WHERE item_id = ? AND revision = ? ORDER BY rowid DESC LIMIT 1").get(a.itemId, a.revision);
      const binding = this.db.prepare("SELECT fingerprint FROM pipeline_item_bindings WHERE item_id = ? AND revision = ?").get(a.itemId, a.revision);
      const automatic = accept && this.db.prepare("SELECT id FROM events WHERE kind = 'reply.queued' AND actor = 'system' AND json_extract(detail, '$.deliveryId') = ?").get(String(accept.id));
      if (automatic) throw new InboxError(409, "required founder approval needs an explicit founder acceptance, not approve-all automation");
      if (!item || item.revision !== a.revision || !["try", "milestone"].includes(String(item.type)) || accept?.action !== "accept" || accept.state === "stale" || !["answer_queued", "delivered"].includes(String(item.state)) || binding?.fingerprint !== run.candidate.fingerprint) throw new InboxError(409, "founder acceptance is missing, stale or not bound to this candidate");
    }
    const evidence: PipelineEvidence = { kind: input.kind, summary: input.summary, id: randomUUID(), byAgentId: actor.id, fingerprint: run.candidate.fingerprint, round: run.round, createdAt: this.now().toISOString(),
      ...(input.path ? { path: input.path } : {}), ...(input.url ? { url: input.url } : {}), ...(input.command ? { command: input.command, exitCode: input.exitCode } : {}),
      ...(input.review ? { review: input.review } : {}), ...(input.approval ? { approval: input.approval } : {}) };
    if (input.path) {
      const original = input.path; const file = realpathSync(original); const s = lstatSync(original);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 20 * 1024 * 1024 || file.split(/[\\/]/).some(part => part.startsWith(".")) || ![".md", ".txt", ".log", ".json", ".png", ".jpg", ".jpeg", ".webp", ".pdf"].includes(extname(file).toLowerCase())) throw new InboxError(422, "attach an explicit non-dot regular evidence file of an allowed type/size");
      const bytes = readFileSync(file); evidence.sha256 = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(this.evidenceDir, { recursive: true }); const stored = join(this.evidenceDir, evidence.id + extname(file));
      copyFileSync(file, stored); created.push(stored); evidence.storedPath = stored; evidence.fileUrl = `/api/pipeline/evidence/${evidence.id}`;
      this.db.prepare("INSERT INTO pipeline_files (id, run_id, file, sha256) VALUES (?, ?, ?, ?)").run(evidence.id, run.id, stored, evidence.sha256);
    }
    if (input.url && !/^https?:\/\/[^/]+/.test(input.url)) throw new InboxError(422, "evidence URL must be http(s)");
    if (["report", "artifact"].includes(input.kind) && !input.path && !input.url) throw new InboxError(422, "report/artifact evidence needs an explicit file or URL");
    return evidence;
  }
  private checkWork(id: string, round: number | undefined, teamId: string, fingerprint?: string): void {
    const row = this.db.prepare("SELECT round, to_team_id, state FROM work WHERE id = ?").get(id);
    if (!row || row.to_team_id !== teamId) throw new InboxError(403, "only the receiving team may bind its review run");
    if (row.round !== round || row.state !== "in_review") throw new InboxError(409, "stale review work round", "pipeline_stale_round");
    const binding = this.db.prepare("SELECT fingerprint FROM pipeline_work_bindings WHERE work_id = ? AND round = ?").get(id, round!);
    if (binding && fingerprint && binding.fingerprint !== fingerprint) throw new InboxError(409, "review candidate differs from the handed-over candidate", "pipeline_stale_candidate");
  }
  gate(actor: WorldAgent, input: PipelineGateInput): PipelineGateResult {
    const run = this.get(input.runId); const reasons: string[] = [];
    this.lead(actor, run.teamId);
    if (run.state !== "open") reasons.push(`run is already ${run.state}`);
    if (run.round !== input.round) reasons.push("stale run round");
    if (run.candidate.head !== input.candidate || !sameCandidate(run.candidate)) reasons.push("stale candidate");
    if (input.delivery === "dev") try {
      if (capture(run.candidate.checkout, run.candidate.head, run.candidate.head).changedPaths.length) reasons.push("commit intended bytes and refresh the candidate pin before dev delivery; never sweep unrelated dirt");
    } catch { reasons.push("committed dev candidate is unavailable"); }
    const view = this.teamView(run.teamId);
    if (!view.graph || !view.repoRoot) reasons.push("protected pipeline or repository is unavailable");
    reasons.push(...selected(run.graph, run.selections), ...pathProblems(run.graph, run.selections, run.candidate.changedPaths));
    const { active, edges } = activation(run.graph, run.selections);
    let required = new Set([...active].filter(id => run.graph.nodes.find(n => n.id === id)?.kind !== "delivery"));
    if (input.nodeId) {
      const node = run.graph.nodes.find(n => n.id === input.nodeId);
      if (!node || !active.has(node.id) || !node.evidence?.includes("review") || input.delivery !== "handoff") reasons.push("not an active internal review step");
      required = new Set<string>();
      const visit = (id: string) => { for (const e of run.graph.edges.filter(e => e.to === id && edges.has(e.id))) if (!required.has(e.from)) { required.add(e.from); visit(e.from); } };
      if (node) visit(node.id);
    } else if (!run.graph.nodes.some(n => n.kind === "delivery" && n.delivery === input.delivery && active.has(n.id))) reasons.push(`no active ${input.delivery} boundary`);
    for (const step of run.steps) if (required.has(step.nodeId) && step.state !== "done") reasons.push(`${step.nodeId}: ${step.state}`);
    const palette = this.palette(run.teamId);
    for (const n of run.graph.nodes.filter(n => required.has(n.id) && n.source)) {
      const source = palette.entries.find(d => d.id === n.source);
      if (!source || source.hash !== run.definitionHashes[n.source!]) reasons.push(`${n.id}: source definition changed or unavailable`);
    }
    if (input.delivery === "review") {
      if (!input.workId || run.workId !== input.workId || run.workRound !== input.workRound) reasons.push("review run is bound to another work round");
      else this.checkWork(input.workId, input.workRound, run.teamId, run.candidate.fingerprint);
    }
    if (input.operation) {
      if (input.delivery !== "dev" || !input.repo || !input.ref) reasons.push("protected Git operation needs dev boundary, repository and ref");
      if (["pr", "merge"].includes(input.operation)) reasons.push("v1 has no authorized release/PR/merge boundary");
      if (input.repo) try { if (repository(input.repo).common !== repository(run.candidate.repoRoot).common) reasons.push("operation repository does not match run"); } catch { reasons.push("operation repository unavailable"); }
      const branch = view.repoRoot ? this.adapters.read(view.repoRoot, basename(view.repoRoot)).adapter?.integrationBranch ?? "dev" : "dev";
      const target = input.ref?.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
      if (target !== branch || target === "main" || target === "master") reasons.push("ref is not the run repository's protected dev delivery branch");
    }
    for (const step of run.steps.filter(s => required.has(s.nodeId))) for (const e of step.evidence) {
      if (e.round !== run.round || e.fingerprint !== run.candidate.fingerprint) { reasons.push(`${step.nodeId}: stale evidence`); continue; }
      try {
        if (e.kind === "approval" || e.kind === "review") this.evidence(actor, run, { ...e, path: undefined }, []);
        if (e.storedPath && this.evidenceFile(e.id) !== e.storedPath) reasons.push(`${step.nodeId}: attachment changed`);
      } catch { reasons.push(`${step.nodeId}: evidence no longer valid`); }
    }
    return { allowed: !reasons.length, runId: run.id, round: run.round, candidate: run.candidate.head, reasons: [...new Set(reasons)] };
  }
  /** Called INSIDE Messages' transaction. Ungoverned teams retain their existing behavior. */
  requireDelivery(actor: WorldAgent, delivery: "handoff" | "review", input?: PipelineGateInput): PipelineRun | null {
    if (!actor.teamId) return null;
    const view = this.teamView(actor.teamId);
    if (!view.protected) return null;
    this.lead(actor, actor.teamId);
    if (!input || input.delivery !== delivery) throw new InboxError(409, "protected delivery needs a pipeline run, candidate and round", "pipeline_gate_required");
    const run = this.raw(input.runId);
    if (run.teamId !== actor.teamId) throw new InboxError(403, "this is another team's run");
    const result = this.gate(actor, input);
    if (!result.allowed) throw new InboxError(409, `delivery refused: ${result.reasons.join("; ")}`, "pipeline_gate_blocked");
    return run;
  }
  delivered(run: PipelineRun, workId: string, workRound: number, internal = false): void {
    this.db.prepare("INSERT OR REPLACE INTO pipeline_work_bindings (work_id, round, run_id, fingerprint) VALUES (?, ?, ?, ?)").run(workId, workRound, run.id, run.candidate.fingerprint);
    if (!internal) { run.state = "delivered"; run.workId = workId; run.workRound = workRound; this.persist(run); }
  }
  presentation(actor: WorldAgent, runId: string): string {
    const run = this.get(runId); this.lead(actor, run.teamId);
    if (run.state !== "open" || !sameCandidate(run.candidate)) throw new InboxError(409, "cannot present a stale or closed candidate");
    return `Pipeline snapshot: run ${run.id}, round ${run.round}, candidate ${run.candidate.head}, intended bytes ${run.candidate.fingerprint}.`;
  }
  evidenceFile(id: string): string {
    const row = this.db.prepare("SELECT file, sha256 FROM pipeline_files WHERE id = ?").get(id);
    if (!row || !within(this.evidenceDir, String(row.file))) throw new InboxError(404, "no pipeline evidence file");
    const file = String(row.file);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || !within(realpathSync(this.evidenceDir), realpathSync(file)) || createHash("sha256").update(readFileSync(file)).digest("hex") !== row.sha256) throw new InboxError(409, "pipeline attachment changed or escaped storage");
    return file;
  }
  bindItem(actor: WorldAgent, runId: string, itemId: string, revision: number): void {
    const run = this.get(runId); this.lead(actor, run.teamId);
    if (!sameCandidate(run.candidate)) throw new InboxError(409, "cannot present a stale candidate");
    this.db.prepare("INSERT INTO pipeline_item_bindings (item_id, revision, run_id, fingerprint) VALUES (?, ?, ?, ?) ON CONFLICT(item_id,revision) DO NOTHING").run(itemId, revision, run.id, run.candidate.fingerprint);
  }
  status(actor: WorldAgent, runId?: string): PipelineStatus {
    if (!actor.teamId) throw new InboxError(409, "join a team to view its pipeline");
    const team = this.teamView(actor.teamId); const run = runId ? this.get(runId) : team.runs.find(r => r.state === "open") ?? null;
    if (run && run.teamId !== actor.teamId) throw new InboxError(403, "this run belongs to another team");
    return { team, run, text: this.brief(actor.teamId, actor.id, run) };
  }
  brief(teamId: string, actorId?: string, given?: PipelineRun | null): string {
    const view = this.teamView(teamId);
    if (!view.protected) return "Pipeline: no default or team override yet.";
    const run = given === undefined ? view.runs.find(r => r.state === "open") ?? null : given;
    const role = actorId === undefined || this.context(teamId).lead?.id === actorId ? "You own this pipeline: select branches, assign/start crew, collect evidence and mark steps done. Only you may deliver." : "Do your assigned step and use inbox pipeline report; only your first mate may complete steps or deliver.";
    return [`Pipeline: ${view.graph?.label ?? "unavailable"} (${view.source}, policy ${view.policyHash?.slice(0, 12) ?? "missing"}). ${role}`,
      ...view.problems, ...(run ? [`Run ${run.id} (${run.state}${run.abandonment ? `: ${run.abandonment.notes}` : ""}), revision ${run.revision}, round ${run.round}, candidate ${run.candidate.head}. Branches: ${JSON.stringify(run.selections)}.`, ...run.steps.filter(s => s.state !== "inactive").map(s => `${s.nodeId}: ${s.state}${s.assignedTo ? ` (${s.assignedTo})` : ""}; evidence: ${run.graph.nodes.find(n => n.id === s.nodeId)?.evidence?.join(", ") ?? "branch/boundary"}`)] : ["Start a bounded wave: inbox pipeline start --base BASE --candidate HEAD."]),
      "Commands: inbox pipeline start|branch|abandon|assign|done|report|status|gate. No model is called; a gate allow is preflight, never a publication receipt."].join("\n");
  }
  private atomic<T>(fn: () => T): T {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); if (own) { this.db.exec("COMMIT"); this.changed(); } return result; }
    catch (err) { if (own) this.db.exec("ROLLBACK"); throw err; }
  }
}
