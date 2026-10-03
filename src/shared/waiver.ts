// The exact-SHA repair waiver's data contract, shared by the service, CLI, UI and any other
// enforcement point (such as a GitHub ruleset bot). docs/DESIGN.md describes the rules.

export type WaiverState = "requested" | "granted" | "refused" | "used" | "expired";

/** One founder-only allowance: exactly `candidate` to exactly `ref` in exactly one repository, once. */
export interface PipelineWaiver {
  id: string;
  /** The repository's Git common dir: its identity across all its worktrees. */
  repoCommon: string;
  /** Its main checkout, for display. */
  repoRoot: string;
  /** Short branch name, such as `dev`. */
  ref: string;
  /** The ref whose position was shown: `refs/remotes/origin/<ref>` when it exists, else `refs/heads/<ref>`. */
  targetRef: string;
  /** Full commit id that may be delivered. */
  candidate: string;
  /** `targetRef`'s commit when the diff was taken. The waiver is usable only while `targetRef` still points here. */
  base: string;
  /** `git diff --stat base candidate`, as the founder saw it. */
  diffStat: string;
  /** sha256 of the full `git diff base candidate` the founder was shown (before any display truncation). */
  diffSha256: string;
  reason: string;
  requestedBy: string;
  requestedTeamId: string | null;
  /** Whether the requester was the lead, or crew on a team with no lead online. */
  requesterRole: "lead" | "crew";
  itemId: string | null;
  state: WaiverState;
  requestedAt: string;
  /** When the founder's explicit choice was recorded, and which reply it was. */
  decidedAt: string | null;
  decidedReply: string | null;
  /** A request expires unanswered at this time; once granted, the allowance expires at this time. */
  expiresAt: string;
  /** First allowed gate call. Later boundaries of that same delivery (a tool preflight, then Git's pre-push) stay allowed until `usedUntil`, while `targetRef` still points to `base`. */
  usedAt: string | null;
  usedBy: string | null;
  usedUntil: string | null;
}

/** POST /api/agent/pipeline/waiver */
export interface WaiverRequestInput {
  clientId: string;
  repo: string;
  ref: string;
  candidate: string;
  reason: string;
}

/** POST /api/agent/pipeline/waiver/gate: a protected delivery that names no pipeline run. */
export interface WaiverGateInput {
  repo: string;
  ref: string;
  candidate: string;
  operation?: "push" | "pr" | "merge" | "land" | "publish";
}

export interface WaiverGateResult {
  allowed: boolean;
  waiverId: string | null;
  candidate: string;
  reasons: string[];
}

