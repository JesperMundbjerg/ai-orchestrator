// A status provider can miss a turn's end. Only observed, unchanged visible output is
// evidence of staleness; elapsed working time alone (or an unreadable pane) never is.
import { createHash } from "node:crypto";

export const STALE_WORKING_MS = 3 * 60_000;
export const PANE_SAMPLE_MS = 30_000;
type Agent = { pane_id: string; agent?: string; agent_session?: { value?: string }; agent_status?: string };
type Watch = { identity: string; workingSince: number; sampledAt?: number; unchangedSince?: number; hash?: string; stale: boolean };

export class StaleWorking {
  private watches = new Map<string, Watch>();

  reset(paneId: string): void { this.watches.delete(paneId); }
  isStale(paneId: string): boolean { return this.watches.get(paneId)?.stale ?? false; }

  async sample(agents: Agent[], queued: ReadonlySet<string>, read: (paneId: string) => Promise<string>, now: () => number): Promise<void> {
    const working = new Set(agents.filter((a) => a.agent_status === "working").map((a) => a.pane_id));
    for (const pane of this.watches.keys()) if (!working.has(pane)) this.watches.delete(pane);
    await Promise.all(agents.filter((a) => working.has(a.pane_id)).map(async (a) => {
      const at = now();
      const identity = `${a.agent}|${a.agent_session?.value}`;
      let watch = this.watches.get(a.pane_id);
      if (!watch || watch.identity !== identity) {
        watch = { identity, workingSince: at, stale: false };
        this.watches.set(a.pane_id, watch);
      }
      if (!queued.has(a.pane_id) && at - watch.workingSince < STALE_WORKING_MS) return;
      if (watch.sampledAt !== undefined && at - watch.sampledAt < PANE_SAMPLE_MS) return;
      watch.sampledAt = at;
      try {
        const text = await read(a.pane_id);
        // A disappearing/empty pane is not proof that it is safe to type.
        if (!text.trim()) throw new Error("empty pane");
        if (this.watches.get(a.pane_id) !== watch) return;
        const hash = createHash("sha256").update(text).digest("hex");
        if (hash !== watch.hash) {
          watch.hash = hash;
          watch.unchangedSince = now();
        }
        watch.stale = now() - watch.unchangedSince! >= STALE_WORKING_MS;
      } catch {
        watch.hash = undefined;
        watch.unchangedSince = undefined;
        watch.stale = false;
      }
    }));
  }
}
