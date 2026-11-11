// What the founder must act on among page comments: one rule, shared by the office's
// GET /api/page-comments/awaiting, the office UI, and any page or release gate that ports it.
// Pure: no I/O. A release gate blocks on exactly this list (DESIGN "Still wrong reopens the same comment").

import type { PageComment, PageCommentStatus } from "./pagecomments.ts";

/** judge: fixed and not judged yet. answer: sent back, and the lead asked him a question about it. waiting: sent back (or a
 * legacy follow-up chain still open); the team is on it. */
export type AwaitingAction = "judge" | "answer" | "waiting";

/** What a waiting comment waits on. */
export type AwaitingOn =
  /** The team is reworking it (status working, delivered, queued…; landing when its commit waits for the branch). */
  | { kind: "fix"; status: PageCommentStatus; landing: { commit: string; branch: string } | null }
  /** The lead asked a question about the rework: the founder's (or the page's) answer moves it on. */
  | { kind: "answer"; question: string | null }
  /** A legacy still-wrong comment: the open end of its follow-up chain (status null when that comment is not known;
   * id null when it has no follow-up at all). */
  | { kind: "follow-up"; id: string | null; status: PageCommentStatus | null };

export interface AwaitingEntry<T extends AwaitingComment = PageComment> {
  comment: T;
  action: AwaitingAction;
  /** Since when it has awaited the founder: when it turned fixed (judge), when he sent it back (answer, waiting). */
  since: string;
  /** Whether he may release without it (POST /api/page-comments/:id/release-without): one to answer or waiting, never one to judge. */
  releaseWithout: boolean;
  /** Null for judge. */
  waitingOn: AwaitingOn | null;
}

/** The fields the rule reads. */
export type AwaitingComment = Pick<PageComment,
  "id" | "teamId" | "origin" | "status" | "verification" | "verifiedAt" | "followUps" | "fixedAt" | "history" | "releasedWithout" | "question" | "landing" | "updatedAt">;

/** Released without it, and not fixed again since. */
function released(c: AwaitingComment): boolean {
  if (!c.releasedWithout) return false;
  return !(c.fixedAt && c.fixedAt > c.releasedWithout.at);
}

/**
 * A legacy still-wrong comment's follow-up chain (from before still-wrong reopened the same comment): resolved once
 * some follow-up was verified or withdrawn (through further still-wrong follow-ups too); otherwise the open end.
 */
function chainEnd(c: AwaitingComment, byId: Map<string, AwaitingComment>, seen: Set<string>): { resolved: true } | { resolved: false; id: string | null; status: PageCommentStatus | null } {
  let open: { id: string | null; status: PageCommentStatus | null } | null = null;
  for (const id of c.followUps) {
    if (seen.has(id)) continue;
    seen.add(id);
    const f = byId.get(id);
    if (!f) { open ??= { id, status: null }; continue; }
    if (f.verification === "verified" || f.status === "withdrawn") return { resolved: true };
    if (f.status === "fixed" && f.verification === "still-wrong") {
      const deeper = chainEnd(f, byId, seen);
      if (deeper.resolved) return deeper;
      open = { id: deeper.id, status: deeper.status };
      continue;
    }
    open = { id, status: f.status };
  }
  return open ? { resolved: false, ...open } : { resolved: false, id: null, status: null };
}

/** One comment's place on the list, or null when the founder has nothing to do on it. */
export function awaitingEntry<T extends AwaitingComment>(c: T, byId: Map<string, AwaitingComment>): AwaitingEntry<T> | null {
  if (c.status === "withdrawn" || c.status === "declined") return null;
  if (released(c)) return null;
  if (c.status === "fixed") {
    if (c.verification === null) return { comment: c, action: "judge", since: c.fixedAt ?? c.updatedAt, releaseWithout: false, waitingOn: null };
    if (c.verification === "verified") return null;
    // Legacy: still wrong before reopening existed; it waits on its follow-up chain.
    const end = chainEnd(c, byId, new Set([c.id]));
    if (end.resolved) return null;
    return { comment: c, action: "waiting", since: c.verifiedAt ?? c.updatedAt, releaseWithout: true, waitingOn: { kind: "follow-up", id: end.id, status: end.status } };
  }
  const last = c.history.at(-1);
  if (!last) return null;
  const waitingOn: AwaitingOn = c.status === "asked" ? { kind: "answer", question: c.question } : { kind: "fix", status: c.status, landing: c.landing };
  return { comment: c, action: c.status === "asked" ? "answer" : "waiting", since: last.judgedAt, releaseWithout: true, waitingOn };
}

/**
 * Every comment the founder must act on, oldest first: fixed ones to judge, sent-back ones whose lead asked him something
 * to answer, and sent-back ones (reopened, or legacy chains not yet ended) he waits on; he may release without the last two. Declined, withdrawn, verified and released-without ones are
 * not on it. `comments` must hold the follow-ups of legacy chains (a missing one counts as open); the filter picks
 * which comments are listed, never which are looked up.
 */
export function awaitingFounder<T extends AwaitingComment>(comments: readonly T[], filter: { origin?: string; team?: string } = {}): AwaitingEntry<T>[] {
  const byId = new Map<string, AwaitingComment>(comments.map((c) => [c.id, c]));
  const origin = filter.origin?.toLowerCase();
  const out: AwaitingEntry<T>[] = [];
  for (const c of comments) {
    if (filter.team && c.teamId !== filter.team) continue;
    if (origin && c.origin !== origin) continue;
    const entry = awaitingEntry(c, byId);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => a.since.localeCompare(b.since) || a.comment.id.localeCompare(b.comment.id));
}
