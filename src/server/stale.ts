// A status provider can miss a turn's end. Only observed, unchanged visible output is
// evidence of staleness; elapsed working time alone (or an unreadable pane) never is.
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export const STALE_WORKING_MS = 3 * 60_000;
export const PANE_SAMPLE_MS = 30_000;
type Agent = { pane_id: string; agent?: string; agent_session?: { value?: string }; agent_status?: string; screen_detection_skipped?: boolean };
type Watch = { identity: string; workingSince: number; sampledAt?: number; unchangedSince?: number; hash?: string; stale: boolean; visibleWorking: boolean; readable: boolean };

/** Pi's editor border is live turn UI, not output progress. A frozen spinner is still busy.
 * Include custom working labels, retry/compaction and narrow spinner-only borders. Only
 * inspect the bottom of the viewport, never an old quoted spinner in scrollback. */
function piWorking(text: string): boolean {
  const bottom = stripVTControlCharacters(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-12);
  return bottom.some((line) => /^─{1,3}\s*[^─\s].*─+$/.test(line)
    || /^─{0,3}\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s|─|$)/.test(line)
    || /^Working\.\.\./.test(line));
}

/** Pi presence can be stale, but arbitrary quiet output cannot disprove it.
 * Recognize the standard empty editor (two complete plain borders) and context footer;
 * custom, cropped, draft-filled or otherwise ambiguous screens keep the lifecycle status. */
function piIdle(text: string): boolean {
  const lines = stripVTControlCharacters(text).split(/\r?\n/).map((line) => line.trim()).slice(-16);
  const bottom = lines.findLastIndex((line) => /^─{5,}$/.test(line));
  if (bottom < 2 || !lines.slice(bottom + 1).some((line) => /\bctx\s+[\d.]+%|(?:[\d.]+%|\?)\/\d+[kKmM]?/.test(line))) return false;
  let top = bottom - 1;
  while (top >= 0 && !lines[top]) top--;
  return top < bottom - 1 && lines[top] === lines[bottom];
}

export class StaleWorking {
  private watches = new Map<string, Watch>();

  reset(paneId: string): void { this.watches.delete(paneId); }
  isStale(paneId: string): boolean { return this.watches.get(paneId)?.stale ?? false; }
  visibleWorking(paneId: string): boolean { return this.watches.get(paneId)?.visibleWorking ?? false; }
  unreadable(paneId: string): boolean { return this.watches.get(paneId)?.readable === false; }

  async sample(agents: Agent[], queued: ReadonlySet<string>, read: (paneId: string) => Promise<string>, now: () => number, force: ReadonlySet<string> = new Set()): Promise<void> {
    // A stale lifecycle idle signal must not defeat a visible Pi working border either.
    const observed = new Set(agents.filter((a) => a.agent_status === "working"
      || (a.agent === "pi" && (a.agent_status === "idle" || a.agent_status === "done"))).map((a) => a.pane_id));
    for (const pane of this.watches.keys()) if (!observed.has(pane)) this.watches.delete(pane);
    await Promise.all(agents.filter((a) => observed.has(a.pane_id)).map(async (a) => {
      const at = now();
      const identity = `${a.agent}|${a.agent_session?.value}|${a.agent_status}|${a.screen_detection_skipped}`;
      let watch = this.watches.get(a.pane_id);
      if (!watch || watch.identity !== identity) {
        watch = { identity, workingSince: at, stale: false, visibleWorking: false, readable: true };
        this.watches.set(a.pane_id, watch);
      }
      if (!force.has(a.pane_id)) {
        if (!queued.has(a.pane_id) && (a.agent_status !== "working" || at - watch.workingSince < STALE_WORKING_MS)) return;
        if (watch.sampledAt !== undefined && at - watch.sampledAt < PANE_SAMPLE_MS) return;
      }
      watch.sampledAt = at;
      try {
        const text = await read(a.pane_id);
        // A disappearing/empty pane is not proof that it is safe to type.
        if (!text.trim()) throw new Error("empty pane");
        if (this.watches.get(a.pane_id) !== watch) return;
        watch.readable = true;
        watch.visibleWorking = a.agent === "pi" && piWorking(text);
        if (watch.visibleWorking || (a.agent === "pi" && !piIdle(text))) {
          watch.hash = undefined;
          watch.unchangedSince = undefined;
          watch.stale = false;
          return;
        }
        const hash = createHash("sha256").update(text).digest("hex");
        if (hash !== watch.hash) {
          watch.hash = hash;
          watch.unchangedSince = now();
        }
        watch.stale = now() - watch.unchangedSince! >= STALE_WORKING_MS;
      } catch {
        if (this.watches.get(a.pane_id) !== watch) return;
        watch.readable = false;
        watch.hash = undefined;
        watch.unchangedSince = undefined;
        watch.stale = false;
      }
    }));
  }
}
