// Loading the lazy pipeline editor can fail in two different ways. Keep the
// decision logic pure so node:test covers it; PipelineButton only wires it up.

export type LoadFailureKind = "stale-chunk" | "render";

// The wording differs per engine: Chrome/Edge, Firefox, Safari, and Vite's own preload helper.
const CHUNK_FAILURE = /dynamically imported module|importing a module script failed|failed to load module script|unable to preload css|loading (css )?chunk \S+ failed/i;

/** A failed chunk fetch means the page predates the build on disk; anything else is the editor's own render crash. */
export function classifyLoadFailure(error: unknown): LoadFailureKind {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "ChunkLoadError" || CHUNK_FAILURE.test(message) ? "stale-chunk" : "render";
}

export type FailureNotice = { kind: LoadFailureKind; message: string; detail: string; canReload: boolean };

export function describeLoadFailure(error: unknown): FailureNotice {
  const kind = classifyLoadFailure(error);
  const detail = error instanceof Error ? error.message : String(error);
  return kind === "stale-chunk"
    ? { kind, canReload: true, detail, message: "Pipeline editor could not load: this page is older than the office build, or the office is not serving it. Reload the page to get the current one." }
    : { kind, canReload: false, detail, message: "Pipeline editor crashed while rendering." };
}

const GUARD_KEY = "review-inbox:pipeline-chunk-reload";
const GUARD_WINDOW_MS = 30_000;
export type GuardStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Allow at most one automatic reload per window. Without storage there is no loop guard, so never reload. */
export function claimReload(storage: GuardStorage | null, now: number): boolean {
  try {
    if (!storage) return false;
    const last = Number(storage.getItem(GUARD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < GUARD_WINDOW_MS) return false;
    storage.setItem(GUARD_KEY, String(now));
    return true;
  } catch { return false; }
}
export function releaseReload(storage: GuardStorage | null): void {
  try { storage?.removeItem(GUARD_KEY); } catch { /* storage may be blocked; the guard then simply expires */ }
}

const REOPEN_KEY = "review-inbox:pipeline-reopen";
/** The reload wipes the open editor; remember which team asked so the reloaded page can reopen it. */
export function rememberReopen(storage: GuardStorage | null, teamId: string, now: number): void {
  try { storage?.setItem(REOPEN_KEY, JSON.stringify({ teamId, at: now })); } catch { /* the founder just clicks Pipeline again */ }
}
/** One-shot: true only for the remembered team, and only shortly after the reload. */
export function takeReopen(storage: GuardStorage | null, teamId: string, now: number): boolean {
  try {
    const raw = storage?.getItem(REOPEN_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { teamId?: unknown; at?: unknown };
    if (saved.teamId !== teamId) return false;
    storage!.removeItem(REOPEN_KEY);
    return typeof saved.at === "number" && now - saved.at < GUARD_WINDOW_MS;
  } catch { return false; }
}

export type LoadEnvironment = { storage: GuardStorage | null; now: () => number; reload: () => void };

/**
 * Run a dynamic import. A stale chunk cannot be fixed by retrying the same
 * URL (browsers remember the failed fetch), so reload once to pick up the
 * current index.html. If that did not help, rethrow for the boundary to name.
 * The returned promise stays pending while the reload happens, so the
 * "Loading" fallback is shown instead of a flash of the error.
 */
export async function importWithRecovery<T>(load: () => Promise<T>, env: LoadEnvironment): Promise<T> {
  try {
    const loaded = await load();
    releaseReload(env.storage);
    return loaded;
  } catch (error) {
    if (classifyLoadFailure(error) === "stale-chunk" && claimReload(env.storage, env.now())) {
      console.warn("Pipeline editor chunk is stale; reloading the page once.", error);
      env.reload();
      return new Promise<T>(() => {});
    }
    throw error;
  }
}

export function browserEnvironment(): LoadEnvironment {
  let storage: GuardStorage | null = null;
  try { storage = window.sessionStorage; } catch { /* blocked storage */ }
  return { storage, now: () => Date.now(), reload: () => window.location.reload() };
}
