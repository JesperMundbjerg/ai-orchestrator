// A project's standing lanes that declare an `attach` command in `orchestrator.json`: whether the
// session the project registered for the lane is really connected, and the founder's explicit
// Recover. The project's own command decides and does the attaching; the office only runs that
// argv (status read-only, recover on an explicit request), checks its answer against what herdr
// shows, and never renames, moves messages or changes a lead. No timer: a lane is checked when
// it is read, at most every 30 s, and once after a recovery. It claims no more than "connected":
// the project's `progressAt` is shown as its last completed turn, never as proof of work. Nothing here is stored: after a
// restart the command's status is the truth, and repeating a recovery is the command's own
// idempotent retry.

import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import type { AdapterLane, AttachReport, LaneRecovery, Repository, StandingLane, WorldAgent, WorldState } from "../shared/types.ts";
import { InboxError } from "./inbox.ts";
import { repositoryFor } from "./queue.ts";
import type { AgentSource, LiveAgent } from "./world.ts";

/** How long a lane's status is reused before a read checks it again. */
export const STATUS_TTL_MS = 30_000;
export const STATUS_TIMEOUT_MS = 20_000;
export const RECOVER_TIMEOUT_MS = 120_000;

/** What the attach command's exit code means; its JSON must say the same. */
const EXIT_STATES: Record<number, AttachReport["state"]> = { 0: "connected", 3: "disconnected", 4: "busy", 5: "unavailable", 6: "refused", 7: "failed" };

export interface AttachRun { code: number | null; stdout: string; error?: string }
export type AttachRunner = (argv: string[], cwd: string, timeoutMs: number) => Promise<AttachRun>;

/** Runs the argv without a shell. `node` is the node running the office, so PATH need not have one. */
export const runAttach: AttachRunner = (argv, cwd, timeoutMs) => new Promise((done) => {
  const [command, ...args] = argv;
  execFile(command === "node" ? process.execPath : command!, args, { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => {
    const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
    const killed = !!err && (err as { killed?: boolean }).killed;
    done({ code, stdout: String(stdout ?? ""), ...(code === null || killed ? { error: killed ? `did not finish within ${Math.round(timeoutMs / 1000)} s` : (err as Error).message } : {}) });
  });
});

/** The command's answer, or why it cannot be trusted: its last stdout line, agreeing with its exit code. */
export function readReport(run: AttachRun): { report: AttachReport } | { transport: string } {
  if (run.error) return { transport: `the attach command ${run.error}` };
  const expected = run.code === null ? undefined : EXIT_STATES[run.code];
  if (!expected) return { transport: `the attach command exited ${run.code ?? "abnormally"}` };
  const line = run.stdout.trim().split("\n").pop() ?? "";
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { transport: "the attach command's output was not JSON" };
  }
  if (raw.state !== expected) return { transport: `the attach command exited ${run.code} but said ${String(raw.state)}` };
  const reg = raw.registered as Record<string, unknown> | null | undefined;
  const comp = raw.companion as Record<string, unknown> | null | undefined;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    report: {
      state: expected,
      reason: text(raw.reason) ?? expected,
      registered: reg && text(reg.session) ? { session: text(reg.session)!, pane: text(reg.pane) } : null,
      companion: comp && typeof comp.pid === "number" ? { pid: comp.pid, fresh: comp.fresh === true, log: text(comp.log) } : null,
      progressAt: text(raw.progressAt) && !Number.isNaN(Date.parse(String(raw.progressAt))) ? String(raw.progressAt) : null,
      changed: raw.changed === true,
    },
  };
}

interface Checked { report: AttachReport | null; transport: string | null; checkedAt: number; seq: number; label: string; lane: AdapterLane; root: string }
/** A status run in flight; `seq` orders it against a recovery, which only trusts a run that started after it. */
interface Checking { seq: number; done: Promise<void> }

/** Who the office sees in a session: running in herdr, then the office agent in that pane. */
interface Holder { live: LiveAgent; agent: WorldAgent | null }

export class StandingLanes {
  private world: () => WorldState;
  private source: Pick<AgentSource, "available" | "live" | "refresh"> | null;
  private run: AttachRunner;
  private now: () => Date;
  private checked = new Map<string, Checked>();
  private checking = new Map<string, Checking>();
  private seq = 0;
  private recoveries = new Map<string, LaneRecovery>();
  /** Something a lane shows changed; the service broadcasts it. */
  onChange: () => void = () => {};

  constructor(world: () => WorldState, source: Pick<AgentSource, "available" | "live" | "refresh"> | null, opts: { run?: AttachRunner; now?: () => Date } = {}) {
    this.world = world;
    this.source = source;
    this.run = opts.run ?? runAttach;
    this.now = opts.now ?? (() => new Date());
  }

  /** Every lane with an attach command, checking again any whose status is older than 30 s. */
  list(state = this.world()): StandingLane[] {
    return this.declared(state).map(({ repo, lane }) => {
      this.refreshIfOld(repo, lane);
      return this.view(state, repo, lane);
    });
  }

  /**
   * The office agent a lane's verified registration names, for joining the lane by it instead of
   * a herdr name. Null when the lane declares no attach command or its status is not known yet
   * (the old rules apply); `agentId` null when the session is not running or is ambiguous.
   */
  registered = (repoRoot: string, lane: AdapterLane, state: WorldState): { agentId: string | null; why: string } | null => {
    if (!lane.attach) return null;
    this.refreshIfOld(state.repositories.find((r) => r.root === repoRoot) ?? { root: repoRoot }, lane);
    const session = this.checked.get(key(repoRoot, lane.name))?.report?.registered?.session;
    if (!session) return null;
    const holders = this.holders(this.checked.get(key(repoRoot, lane.name))!.report!, state, lane, repoRoot);
    if (holders.length > 1) return { agentId: null, why: `${holders.length} running agents report session ${session}; the lane is not joined to any of them` };
    const agent = holders[0]?.agent ?? null;
    return agent ? { agentId: agent.id, why: "" } : { agentId: null, why: `the registered session ${session} is not running in ${workdir(lane, { root: repoRoot })}` };
  };

  /**
   * The lanes `agent` is the registered running session of, as "project/lane", from what the
   * lanes last said (no command is run for it). Closing, removing or switching such an agent cuts
   * its project off; once the lane is recovered onto a replacement, it no longer holds it.
   */
  holding = (agent: Pick<WorldAgent, "paneId">): string[] => {
    if (!agent.paneId) return [];
    return [...this.checked.values()].flatMap((c) => {
      const holders = c.report?.registered ? this.holders(c.report, null, c.lane, c.root) : [];
      return holders.length === 1 && holders[0]!.live.paneId === agent.paneId ? [c.label] : [];
    });
  };

  /** Checks a lane now (the CLI's `inbox lane`, and after a recovery). */
  async check(project: string, laneName: string): Promise<StandingLane> {
    const state = this.world();
    const { repo, lane } = this.find(state, project, laneName);
    await this.refresh(repo, lane);
    return this.view(this.world(), repo, lane);
  }

  /**
   * The founder's explicit recovery of a lane onto a running agent in its worktree. One at a
   * time per lane. Whatever the command answers is shown as it said it; "attached" only once a
   * status run started after the command confirms that exact session in that pane and checkout.
   */
  async recover(project: string, laneName: string, agentId: string): Promise<StandingLane> {
    const state = this.world();
    const { repo, lane } = this.find(state, project, laneName);
    const k = key(repo.root, lane.name);
    const running = this.recoveries.get(k);
    if (running?.state === "running") throw new InboxError(409, `${lane.name} is already being recovered onto ${running.agentName}; wait for that to finish`);
    const target = this.candidates(state, lane, repo).find((c) => c.agent.id === agentId);
    if (!target) {
      const named = state.agents.find((a) => a.id === agentId)?.name ?? agentId;
      throw new InboxError(409, `${named} is not a team lead running ${lane.harness ? `${lane.harness} ` : ""}in ${workdir(lane, repo)} with a session herdr reports, so ${lane.name} cannot be attached to it; who leads is the founder's choice`);
    }
    const session = target.live.sessionId!;
    const recovery: LaneRecovery = { state: "running", agentId: target.agent.id, agentName: target.agent.name, session, pane: target.live.paneId, at: this.now().toISOString(), reason: null, log: null };
    this.recoveries.set(k, recovery);
    this.onChange();
    try {
      const read = readReport(await this.run([...lane.attach!, "--recover", "--pane", target.live.paneId, "--session", session, "--json"], workdir(lane, repo), RECOVER_TIMEOUT_MS));
      const mark = this.seq;
      if ("transport" in read) {
        Object.assign(recovery, { state: "failed", reason: `${read.transport}; its outcome is not known, so check the lane before recovering again` });
        await this.afterRecovery(repo, lane, mark);
      } else if (read.report.state !== "connected") {
        Object.assign(recovery, { state: read.report.state === "disconnected" ? "failed" : read.report.state, reason: read.report.reason, log: read.report.companion?.log ?? null });
        await this.afterRecovery(repo, lane, mark);
      } else {
        await this.afterRecovery(repo, lane, mark);
        const now = this.view(this.world(), repo, lane);
        const confirmed = now.state === "connected" && now.registered?.session === session && now.registered.agentId === target.agent.id;
        Object.assign(recovery, confirmed
          ? { state: "attached", reason: read.report.changed ? null : "it was already attached to this session; nothing was started", at: this.now().toISOString() }
          : { state: "failed", reason: `the attach command said connected, but a fresh check says: ${now.reason ?? now.state}`, log: read.report.companion?.log ?? null });
      }
    } catch (err) {
      Object.assign(recovery, { state: "failed", reason: `the attach command could not be run: ${(err as Error).message}` });
    }
    this.onChange();
    return this.view(this.world(), repo, lane);
  }

  private declared(state: WorldState): { repo: Repository; lane: AdapterLane }[] {
    return state.repositories.flatMap((repo) => (repo.adapter?.lanes ?? []).filter((l) => l.attach).map((lane) => ({ repo, lane })));
  }

  private find(state: WorldState, project: string, laneName: string): { repo: Repository; lane: AdapterLane } {
    const repo = repositoryFor(state, project);
    const lane = repo.adapter.lanes.find((l) => l.name.toLowerCase() === laneName.toLowerCase());
    if (!lane) throw new InboxError(404, `${project} has no lane called ${laneName}`);
    if (!lane.attach) throw new InboxError(409, `${lane.name} declares no attach command in ${project}'s orchestrator.json, so the office cannot check or recover it`);
    return { repo, lane };
  }

  private refreshIfOld(repo: Lookup, lane: AdapterLane): void {
    const known = this.checked.get(key(repo.root, lane.name));
    if (known && this.now().getTime() - known.checkedAt < STATUS_TTL_MS) return;
    void this.refresh(repo, lane);
  }

  /**
   * What a recovery is judged by: herdr read again and a status run that started after the attach
   * command returned (`mark`). A run already in flight from before it is waited out and its answer
   * replaced, never reused. The board and briefs are told either way.
   */
  private async afterRecovery(repo: Lookup, lane: AdapterLane, mark: number): Promise<void> {
    await this.source?.refresh?.().catch(() => {});
    const k = key(repo.root, lane.name);
    for (;;) {
      const pending = this.checking.get(k);
      if (!pending) await this.refresh(repo, lane);
      else if (pending.seq <= mark) { await pending.done.catch(() => {}); continue; }
      else await pending.done;
      if ((this.checked.get(k)?.seq ?? 0) > mark) break;
    }
    this.onChange();
  }

  /** One status run per lane at a time; a read during it waits for the same run. */
  private refresh(repo: Lookup, lane: AdapterLane): Promise<void> {
    const k = key(repo.root, lane.name);
    const at = { label: `${repo.adapter?.project ?? basename(repo.root)}/${lane.name}`, lane, root: repo.root };
    const pending = this.checking.get(k);
    if (pending) return pending.done;
    const seq = ++this.seq;
    const done = (async () => {
      let next: Checked;
      try {
        const read = readReport(await this.run([...lane.attach!, "--status", "--json"], workdir(lane, repo), STATUS_TIMEOUT_MS));
        next = "transport" in read ? { report: null, transport: read.transport, checkedAt: this.now().getTime(), seq, ...at } : { report: read.report, transport: null, checkedAt: this.now().getTime(), seq, ...at };
      } catch (err) {
        next = { report: null, transport: `the attach command could not be run: ${(err as Error).message}`, checkedAt: this.now().getTime(), seq, ...at };
      }
      const before = this.checked.get(k);
      this.checked.set(k, next);
      const seen = (c: Checked | undefined) => JSON.stringify([c?.report, c?.transport]);
      if (seen(before) !== seen(next)) this.onChange();
    })().finally(() => this.checking.delete(k));
    this.checking.set(k, { seq, done });
    return done;
  }

  /**
   * Who runs the registered session: in herdr, in the lane's own checkout, in the registered pane
   * when the project names one, and on the lane's harness when it declares one. The same session id
   * in another checkout, pane or harness is not the lane's holder; two that match are ambiguous.
   */
  private holders(report: AttachReport, state: WorldState | null, lane: AdapterLane, root: string): Holder[] {
    if (!this.source?.available() || !report.registered) return [];
    const { session, pane } = report.registered;
    return this.source.live()
      .filter((l) => l.sessionId === session && (!pane || l.paneId === pane) && inLane(l, lane, root))
      .map((live) => ({ live, agent: state?.agents.find((a) => a.paneId === live.paneId) ?? null }));
  }

  /**
   * Who a recovery may name: a team's lead running in the lane's checkout with a session the
   * command can be given. A recovery never makes anyone lead; that stays the founder's choice.
   */
  private candidates(state: WorldState, lane: AdapterLane, repo: Repository): { live: LiveAgent; agent: WorldAgent }[] {
    if (!this.source?.available()) return [];
    return this.source.live()
      .filter((l) => l.sessionId && inLane(l, lane, repo.root))
      .flatMap((live) => {
        const agent = state.agents.find((a) => a.paneId === live.paneId);
        return agent?.role === "lead" && agent.teamId ? [{ live, agent }] : [];
      })
      .sort((a, b) => a.agent.name.localeCompare(b.agent.name));
  }

  private view(state: WorldState, repo: Repository, lane: AdapterLane): StandingLane {
    const k = key(repo.root, lane.name);
    const checked = this.checked.get(k);
    const report = checked?.report ?? null;
    const session = report?.registered?.session ?? null;
    const holders = report ? this.holders(report, state, lane, repo.root) : [];
    const holder = holders.length === 1 ? holders[0]!.agent : null;
    const team = (a: WorldAgent | null) => (a?.teamId ? state.teams.find((t) => t.id === a.teamId)?.name ?? null : null);
    const presence = !!this.source?.available();
    let shown: StandingLane["state"];
    let reason: string | null;
    if (!checked) [shown, reason] = ["checking", null];
    else if (!report) [shown, reason] = ["unknown", `${checked.transport}; nothing is concluded from that`];
    else if (report.state === "connected") {
      if (!presence) [shown, reason] = ["unknown", `${repoName(repo)} reports it connected, but the office cannot see herdr to confirm the session runs`];
      else if (holders.length > 1) [shown, reason] = ["unknown", `${holders.length} running agents report session ${session}`];
      else if (!holders.length) [shown, reason] = ["disconnected", `${repoName(repo)} reports it connected, but session ${session}${report.registered?.pane ? ` in pane ${report.registered.pane}` : ""} is not running${lane.harness ? ` ${lane.harness}` : ""} in ${workdir(lane, repo)}`];
      else if (!report.companion?.fresh) [shown, reason] = ["disconnected", `its companion's heartbeat is not fresh: ${report.reason}`];
      else [shown, reason] = ["connected", null];
    } else if (report.state === "disconnected" || report.state === "failed") [shown, reason] = ["disconnected", report.reason];
    else if (report.state === "busy") [shown, reason] = ["busy", report.reason];
    else [shown, reason] = ["unknown", report.reason];

    let recovery = this.recoveries.get(k) ?? null;
    // A later check that no longer shows this session connected in that pane ends what the recovery achieved.
    if (recovery?.state === "attached" && checked && (shown !== "connected" || session !== recovery.session || holders[0]?.live.paneId !== recovery.pane)) recovery = null;
    return {
      project: repo.adapter!.project,
      lane: lane.name,
      repository: repo.root,
      worktree: workdir(lane, repo),
      state: shown,
      reason,
      checkedAt: checked ? new Date(checked.checkedAt).toISOString() : null,
      registered: session ? {
        session, pane: report?.registered?.pane ?? null,
        agentId: holder?.id ?? null, agentName: holder?.name ?? null, teamName: team(holder), role: holder?.role ?? null, running: holders.length > 0,
      } : null,
      companionPid: report?.companion?.pid ?? null,
      lastTurnAt: report?.progressAt ?? null,
      candidates: this.candidates(state, lane, repo).map(({ agent }) => ({ agentId: agent.id, name: agent.name, teamName: team(agent), role: agent.role, harness: agent.harness })),
      recovery: recovery && { ...recovery },
    };
  }
}

type Lookup = Pick<Repository, "root"> & { adapter?: Repository["adapter"] };
const key = (root: string, lane: string) => `${root}\0${lane.toLowerCase()}`;
const workdir = (lane: AdapterLane, repo: Pick<Repository, "root">) => lane.worktree ?? repo.root;
/** Running in the lane's exact checkout (not below it), on its declared harness if it has one. */
const inLane = (l: LiveAgent, lane: AdapterLane, root: string) => !!l.cwd && resolve(l.cwd) === resolve(workdir(lane, { root })) && (!lane.harness || l.harness === lane.harness);
const repoName = (repo: Repository) => repo.adapter?.project ?? repo.name;
