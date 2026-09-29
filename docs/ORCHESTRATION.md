# Orchestration: what moves here from FysikLab

The founder's principle: **this repository owns work and orchestration, reusable for any project; FysikLab owns the website and its own checks and reviewers.** This document maps what FysikLab runs today, the end state, the API FysikLab's comment UI needs from this service, and a migration one step at a time. It is a plan; nothing here is built yet unless it says so.

FysikLab paths below are relative to `/Users/jesper/projects/space-shuttle` (`app/` = `space-app/`).

## 1. Today

### Who does what

| Concern | FysikLab (`app/lib/dev`, `app/scripts`, `.claude`, `.pi`) | This repo |
|---|---|---|
| **Work intake** | Founder comments from the 💬 widget into SQLite (`comment-store.mjs`, `internal/queue-db.mjs`; `../.fysiklab-queue/space-shuttle/comments.db`, 323 comments, 366 markers). Anchored to sim / chapter / step / beat and an origin-free URL. Grouping (hold back until **Send**), images, replay context, `requestId` idempotency. | Nothing like it. Agents post their own items. |
| **Routing** | `dispatch-daemon.mjs` (port 4577) runs passes: writes `dispatch-board.json`, a **Mission Control** agent session answers `dispatch-plan.json` (assign / ask / hold / briefs), the daemon validates and sets `owner`. | Nothing. Teams get your instructions through their lead. |
| **Leases and recovery** | `claimComments` (45 min lease), stranded-claim and wedged-lane sweeps, kicks (`dispatch-recovery.mjs`). | Nothing. |
| **Lanes / agents** | Standing lanes = fixed worktrees in `.claude/worktrees/registry.json`. Started by `lanes/start.mjs`, `pi-lane.mjs`, `start-pool.mjs`, seated into a herdr tab (`pi/seat-core.mjs`). | Agents and teams from herdr; projects are worktrees; starting a project starts a Claude Code first mate. |
| **Liveness** | `lane_heartbeats` rows + herdr `agent list` + git state (`dispatch-lanes.mjs`). | herdr presence + hook/extension activity. |
| **Activity and model** | Pi metrics (`pi/metrics/*`, `fysiklab-metrics.ts`), native-lane hook (`claude/lifecycle.mjs`), transcript usage, footer. | `/api/hooks/claude`, Pi `/api/agent/events`, session-file fallback; model per agent. |
| **Agent messages** | SQLite `messages` table; `queue.mjs say`, Pi `/say`; delivered by `fysiklab-mail.ts` (Pi) and `claude/supervisor.mjs` (herdr `agent prompt`). | `messages` + `message_deliveries`, `inbox say`, delivered with `herdr agent prompt` under guards. |
| **Founder decisions** | `queue.mjs hold --why` (≤ 400 chars) on a comment, answered in the `/dev/queue` panel and folded into the comment text. Away mode allows only product / access / spending / ownership. Static HTML decision pages and founder-walk pages with a copy-paste answer. | The Review Inbox: Decide / Try it / Milestone items, answers delivered to the asking session with acks. |
| **Fix markers / verify** | Worker writes a marker after publishing (`/api/dev/fix-markers`); founder **✓ Verified** or **Send back** (new linked comment, `comment_origins`). | Nothing like it. Milestone review is the nearest. |
| **Worktrees and landing** | `worktree-sync.mjs` + `checkout-landing.mjs`: land a pinned SHA onto `dev` in a detached `.land-*` worktree (ff or cherry-pick), `ff-only` under a lock, conflict flag, publish. `no-extra-worktrees`, `worktree-guard`. | Projects make and remove worktrees through herdr; no landing. |
| **Handoffs and reviews** | `workflow/*` finish state machine, `review-gate.mjs` + `one-review-round` hook (2 reviewers, once each per slice). | `inbox handoff` / `review` between teams. |
| **Checks** | `run-checks.mjs`, `gate-scopes.mjs`, `check-runtime/` (machine lease), ~52 checks. | Nothing, and it should stay that way. |
| **Reviewers** | `.claude/agents/*` roster, `/review-changes`, `/final-checks`. | Nothing, and it should stay that way. |

### Duplicated today

| Part | FysikLab copy | This repo's copy |
|---|---|---|
| **herdr** | `herdr.mjs` (list, get, rename, prompt, pane send-keys, tab create, seat) | `src/server/herdr.ts` (presence, focus, prompt, worktree start/finish) |
| **Messaging** | `messages` table, `fysiklab-mail.ts`, supervisor mail | `messages`, deliveries, `inbox say` |
| **Activity and model** | heartbeats, Pi metrics, native-lane hook, `session/model.mjs` | activity, helpers, model per agent |
| **Worktrees and landing** | registry.json, worktree-sync, checkout-landing | teams with `path` / `branch`, start / finish |
| **Founder decisions** | holds, away mode, decision pages, founder-walk pages | Review Inbox items |
| **Dispatch** | daemon, board / plan handshake, Mission Control lane | team instructions to a lead (no queue, no leases) |

## 2. End goal

### Ownership

| Component | Owner | Notes |
|---|---|---|
| Comments (work intake): store, groups, idempotency, images | **here** | Anchor is opaque, defined by the project. |
| Queue: assign, claim / lease, hold, release, recovery sweeps | **here** | Mechanical rules only. |
| Routing judgement | **an agent** (Mission Control, a standing team's lead) | Not the service: no agent in the middle, no model calls. The service hands it the board and takes its assignments. |
| Fixes (markers): "go look", verify, still wrong | **here** | FysikLab draws the pins. |
| Agents, teams, liveness, activity, model, messages | **here** (already) | FysikLab's heartbeats and mail go away. |
| Starting agents in herdr (Claude Code, Pi), per the project's lane list | **here** | Extends project start. |
| Founder decisions and walkthroughs | **here** (Review Inbox, already) | Replaces holds and HTML pages. |
| Worktrees and landing mechanism | **here**, driven by the adapter | Integration branch, publish and setup commands come from the project. |
| Checks, check scopes, check-runtime lease | **FysikLab** | Agents run them; the service only names them in briefs. |
| Reviewers, roster, one-review-round rule | **FysikLab** | Its own hook keeps enforcing it. |
| Fix charter, anchor meaning, pin rendering, comment widget | **FysikLab** | |
| Harness tweaks (Pi compaction, footer, web tool, quota) | **FysikLab** for now | See open questions. |

### The boundary: a project adapter

A project describes itself in one file at its main checkout's root, `orchestrator.json` (read by the service when the project is registered or the file changes; no code of the project runs inside the service):

```jsonc
{
  "project": "fysiklab",
  "integrationBranch": "dev",               // where work lands
  "preview": { "base": "http://127.0.0.1:${SIM_DEV_PORT:-3000}", "envFile": "space-app/.env.local" },
  "comments": {
    "kinds": ["wrong", "taste", "intent", "unsure"],
    "anchor": ["sim", "chapterId", "step", "beat"],   // keys the service may filter on; the rest is opaque
    "charter": "docs/fix-comments-charter.md",        // what a worker is told to follow
    "leaseMinutes": 45
  },
  "decisions": { "maxQuestion": 400, "awayCategories": ["product", "access", "spending", "ownership"] },
  "checks": {                                        // named in briefs; the service never runs them
    "changed": "npm --prefix space-app run check:changed",
    "full": "npm --prefix space-app run gates",
    "release": "see .claude/commands/pr-to-main.md"
  },
  "reviewers": { "perSlice": ["architecture-reviewer", "physics-accuracy-reviewer"], "cap": "once each per slice" },
  "land": { "mode": "ff-or-cherry-pick", "publish": "git push origin dev", "setup": "node .claude/hooks/worktree-guard.mjs --bootstrap" },
  "lanes": [                                          // standing agents and how to start them
    { "name": "einstein", "worktree": ".claude/worktrees/einstein", "harness": "pi", "model": "openai-codex/gpt-6-astra" },
    { "name": "mission-control", "role": "router", "harness": "pi" }
  ]
}
```

Another project writes its own file and gets the same queue, office, inbox and landing, with no code change here.

## 3. The API for FysikLab's comment UI

Namespaced by project: `/api/p/:project/…`. JSON in and out; errors are `{error: string}` with a 4xx/5xx status (what FysikLab's `devJson` already expects). Absent fields are omitted, never `null`.

### Shapes

```ts
type Anchor = Record<string, string | number | number[]>;  // FysikLab: {sim, chapterId, step, beat, chapterFile, pos3d?}

type Comment = {
  id: string; project: string; createdAt: string;
  text: string; kind: string;                      // one of the adapter's kinds
  anchor: Anchor;
  path?: string;                                   // origin-free URL; the UI adds its own origin
  where?: string;                                  // label for people: "Atoms · Isotopes · step 2"
  images?: string[];                               // served from /files/:id
  link?: string;
  extra?: Record<string, unknown>;                 // project data kept verbatim (FysikLab: replay)
  groupId?: string;
  state: "draft" | "waiting" | "assigned" | "working" | "held" | "fixed" | "done";
  owner?: { agentId: string; name: string };
  claimedAt?: string; leaseUntil?: string;
  held?: { itemId: string; question: string };     // a Review Inbox decision
  brief?: string;                                  // the router's note to the worker
  origin?: { commentId?: string; fixId: string; relation: "still-wrong" | "regression" | "reverted" | "intent" | "guard-request" };
  doneAt?: string;
};

type Fix = {                                       // FysikLab's fix marker
  id: string; commentId?: string; project: string; createdAt: string;
  anchor: Anchor; path?: string; where?: string;
  comment: string; fix: string;                    // what was asked, what was done
  kind: string;                                    // a comment kind, or "owed" (a guard still to build)
  acceptance?: Record<string, unknown>;
  outcome?: "verified" | "requeued"; closedAt?: string;
};

type Lane = {                                      // "who is working", derived from the office
  agentId: string; name: string; harness: string; model?: string;
  state: "idle" | "working" | "blocked" | "held" | "conflict" | "offline";
  doing?: string; branch?: string; carrying: string[]; // comment ids
  why?: string;
};
```

### Endpoints for the UI (through FysikLab's server)

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/p/:p/comments` | `?state=live\|all&anchor.sim=atoms&since=<cursor>` | `{comments: Comment[], openGroup: {id, comments: {id, text}[]} \| null, cursor}` |
| `POST /api/p/:p/comments` | `{text, kind, anchor, path?, where?, images?: dataURL[], link?, extra?, group?: "add", requestId?, origin?: {fixId, relation}}` | `{comment}`; same `requestId` and content → `{comment, idempotent: true}`; different content → 409 |
| `PATCH /api/p/:p/comments/:id` | `{text?, kind?}` (while draft or waiting) | `{comment}`; 409 once assigned |
| `DELETE /api/p/:p/comments/:id` | (while draft or waiting) | `{removed: id}` |
| `POST /api/p/:p/groups/open/send` \| `/discard` | `{}` | `{groupId, count}` |
| `POST /api/p/:p/comments/:id/answer` | `{answer}` | `{comment}` (same as answering its inbox item) |
| `GET /api/p/:p/fixes` | `?outcome=open\|all` | `{fixes: Fix[]}`, oldest first |
| `POST /api/p/:p/fixes/:id/verify` | `{built?: true}` (required for `owed`) | `{fix}`; idempotent; 409 for `owed` without `built` |
| `POST /api/p/:p/fixes/:id/still-wrong` | `{relation, note?}` | `{fix, comment}`: closes the fix as `requeued` and files the linked comment **in one transaction** (today it is two calls) |
| `GET /api/p/:p/queue` | | `{lanes: Lane[], counts: {waiting, assigned, working, held, fixed}, held: Comment[], paused, away}` |
| `POST /api/p/:p/queue` | `{action: "pause" \| "resume" \| "away-on" \| "away-off" \| "route"}` | `{paused, away}` (`route` asks the router now) |
| `GET /api/events` | SSE, as today | `data: {"type":"comments","project":"fysiklab"}` etc. Poll `?since=` is the fallback. |

### Endpoints for agents (CLI `inbox …`, the hook and the Pi extension; identified by session like every agent call)

| Call | Does |
|---|---|
| `POST /api/agent/comments/board` → `{ready: Comment[], lanes: Lane[], rules}` | What the router sees (replaces `dispatch-board.json`). |
| `POST /api/agent/comments/assign` `{assignments: [{commentIds, agent}], holds: [{commentId, question, options?}], briefs: {id: text}}` | The router's plan. Every ready comment must be assigned or held; one bad entry rejects the whole plan with reasons (today's `validatePlan`). |
| `POST /api/agent/comments/slice` | The caller's assigned comments; claims them and renews the lease. |
| `POST /api/agent/comments/hold` `{commentId, question, options?}` | Becomes a Decide item owned by the caller; the comment is `held`. Away mode refuses anything outside the adapter's categories. |
| `POST /api/agent/comments/fix` `{commentIds \| "self", fix, kind, acceptance?}` | Writes the fix and closes the comments in one step; only after publish (the charter says so). |
| `POST /api/agent/comments/release` `{commentIds, reassignTo?}` | Hands work back or on. |

The service's own mechanical rules: an expired lease drops `claimedAt` and keeps `owner`; a comment claimed but not worked for 10 min, or a lane wedged for 30 min, is released and the router told; a ready comment with an idle owner gets one message ("you have N comments"), at most twice per slice. When comments become ready the router gets one office message; it answers with `assign`. The service never picks an owner itself.

### Origin and auth

The service binds `127.0.0.1` and refuses a foreign `Host` or `Origin` (`src/server/http.ts`). A browser on FysikLab's port therefore cannot call it directly, and should not: **FysikLab's Next routes call it server-side**, where there is no `Origin` header. No tokens: like today, anything on the machine can write, and agents identify by their session. If direct browser calls are ever wanted, the adapter could list allowed dev origins; not planned.

### FysikLab's UI keeps working unchanged

With a switch in `space-app/.env.local` (`ORCHESTRATOR_URL=http://127.0.0.1:4870`), FysikLab's existing routes become thin proxies, and its components are not touched:

| FysikLab route | Proxies to | Mapping, in FysikLab (`lib/dev/orchestrator-client.mjs`) |
|---|---|---|
| `GET/POST/PATCH /api/dev/comments` | `/api/p/fysiklab/comments`, `/groups/open/*`, `/comments/:id/answer` | FysikLab still runs `resolveMarkerLocation` and puts the result in `anchor`; on the way back it flattens `anchor`, rederives `chapterNumber` and `url`, and turns `state` / `owner` / `held` into `owner`, `startedAt`, `heldWhy`, `doneAt`. `PATCH {action}` maps to the matching call. |
| `GET/POST/DELETE /api/dev/fix-markers` | `/api/p/fysiklab/fixes`, `/verify`, `/still-wrong` | `DELETE ?outcome=verified[&built=1]` → verify; `outcome=requeued` → the still-wrong call already filed the comment, so the second request is a no-op. |
| `GET/POST /api/dev/dispatch` | `/api/p/fysiklab/queue` | `lanes`, `queue.lifecycle`, `asked` built from `Lane[]`, counts and `held`. |

Polling stays at 3 s and 10 s. SSE through the proxy is a later nicety.

## 4. Migration

Each step ships alone, behind a switch in FysikLab's `.env.local` (off = today's behaviour), and is verified on a scratch office and a copy of the queue before the live one. FysikLab changes are made by FysikLab's own agents in FysikLab; this repo never edits it.

**Step 1. Founder decisions and holds into the Review Inbox.** Lowest risk (holds are rare and self-contained), highest value (one place to answer, with delivery to the asking lane).
- **Moves:** where a hold is answered. Nothing else.
- **Here:** nothing new; `inbox decide` with `--key` exists.
- **FysikLab (`HOLDS_TO_INBOX=1`):** `queue.mjs hold` also runs `inbox decide "<question>" --key comment:<id> [--option …] [--page <comment url>]` as the holding lane (its session owns the item). When the answer arrives in the lane (live for Pi, next turn for Claude), the lane runs `queue.mjs answer <id> "<answer>"`, which folds it into the comment as today. The `/dev/queue` held-question box shows "Answer in the Review Inbox →" instead of a text field, so there is one place to answer.
- **Verify:** hold a test comment from a scratch lane; answer it in the inbox; see it acked and folded into the comment text in a copy of the queue.
- **Roll back:** switch off; withdraw open items with `inbox withdraw comment:<id>`; the panel's answer box returns.
- **Delete afterwards:** the held-question answer UI in `dispatch-panel.tsx`, `/dev/queue` `asked` rendering.

**Step 2. Decision pages and founder walks into the inbox.**
- **Moves:** `/decision-page` → `inbox decide` (options, recommendation, evidence screenshots). `/founder-walk` → a Try it item with `--page` / `--look` per finding (the walkthrough exists here since 81f5aca).
- **FysikLab:** edit the two command files; nothing in `app/`.
- **Verify:** one real decision and one walk answered in the inbox.
- **Roll back:** revert the command files.
- **Delete afterwards:** `.claude/templates/decision-page.html`, `scripts/founder-walk-page.mjs`, the copy-paste formats.

**Step 3. Agent messages through the office.**
- **Moves:** lane-to-lane messages and the daemon's kicks.
- **FysikLab (`MAIL_VIA_OFFICE=1`):** `queue.mjs say <lane>` and Pi `/say` call `inbox say <agent>`; `fysiklab-mail.ts` and the supervisor stop delivering. Switch over only when `messages` has no undelivered rows, so nothing is sent twice or lost.
- **Here:** lane names must resolve to office agents (the adapter's `lanes` give the names).
- **Verify:** a `say` between two scratch lanes appears as delivered in the office.
- **Roll back:** switch off (the office keeps its record; undelivered office messages are few and visible).
- **Delete afterwards:** the `messages` table, `fysiklab-mail.ts`, supervisor mail, `lane-signals` mailbox code.

**Step 4. Who is working, from the office.**
- **Moves:** liveness, state, model and "doing" for the dispatch panel.
- **Here:** `GET /api/p/:p/queue` with `lanes` only (counts come from FysikLab until step 5); the adapter file is read for lane names.
- **FysikLab (`LANES_FROM_OFFICE=1`):** `/api/dev/dispatch` takes `lanes` from the office, the rest from the daemon. Keep heartbeats running for a week and compare.
- **Roll back:** switch off.
- **Delete afterwards:** `lane_heartbeats`, `dispatch-lanes.readLanes`' herdr part, heartbeat code in `fysiklab-lane.ts` and `claude/lifecycle.mjs`.

**Step 5. The comment store (the one with data).**
- **Moves:** comments, groups, fixes, origins and their history.
- **Here:** tables `comments`, `comment_groups`, `fixes`, `comment_events`; the API above; `npm run import-queue -- <comments.db>`, which opens FysikLab's database **read-only** and copies comments, markers (as fixes), dismissals (as outcomes), `comment_origins` and `workflow_events` (as history), keeping ids so links and images still resolve. Images are copied into the data directory.
- **Parallel run, in three switches:**
  1. `COMMENTS_SHADOW=1`: FysikLab keeps its SQLite as the truth and mirrors each write to the service (fire-and-forget, `requestId` makes retries safe). A compare script diffs `GET /api/dev/comments` against the service daily. Run a week.
  2. `COMMENTS_BACKEND=orchestrator`: the routes proxy (table above), and every direct writer (`queue.mjs`, `markers.mjs`, the daemon, the supervisor, `pi-lane`, the lifecycle hook) goes through `comment-store.mjs`, which calls the service instead of SQLite. The old database is still written as a reverse shadow, so switching back loses nothing.
  3. Stop the reverse shadow after two quiet weeks.
- **Cost:** `comment-store.mjs` is synchronous (`DatabaseSync`) and the service is HTTP, so its callers become async. That is the main code change in FysikLab.
- **Verify:** after import, counts and a sample of comments, fixes and origins match; pins show on the same pages; Send back files a linked comment.
- **Roll back:** switch 2 back to `sqlite`; the reverse shadow has kept the database current.
- **Delete afterwards:** `comment-store.mjs` internals, `internal/queue-db.mjs`, migrations, `queue-snapshot.mjs`; `../.fysiklab-queue` is archived, not deleted.

**Step 6. Dispatch.**
- **Moves:** the daemon's mechanical part (leases, sweeps, kicks, pause, away) and the board / plan handshake.
- **Here:** `board`, `assign`, `slice`, `hold`, `fix`, `release`; the sweeps; the router message. Mission Control becomes the lead of a standing team "Mission Control" in the office, told "N comments ready" by message and answering with `inbox assign`.
- **FysikLab (`DISPATCH_VIA_OFFICE=1`):** Mission Control's charter uses `inbox` calls instead of the JSON files; the daemon is not started. Both can not run at once: flip at a moment with no comments `claimed`.
- **Verify:** a comment filed on a scratch copy is assigned by a scratch router, claimed, fixed and verified end to end.
- **Roll back:** switch off and start the daemon; assignments live in the service's store, which the daemon reads through `comment-store.mjs` since step 5.
- **Delete afterwards:** `dispatch-daemon.mjs`, `dispatch-engine.mjs`, `dispatch-board.mjs`, `dispatch-recovery.mjs`, `mission-control.mjs`, `dispatch-*.json` at the repo root, `/dispatch-comments`.

**Step 7. Starting lanes.**
- **Moves:** starting and seating standing agents in herdr.
- **Here:** start Pi as well as Claude Code (model from the adapter), seat standing lanes, restart one that stopped when asked. Lane worktrees become projects or a standing team's members.
- **FysikLab:** `start-pool.mjs` and `lanes/*` call `inbox` to start a lane, behind `LANES_STARTED_BY_OFFICE=1`.
- **Delete afterwards:** `herdr.mjs`, `pi/seat-core.mjs`, `pi/spawn-core.mjs`, `lanes/*`, `start-pool.mjs`, `nameSpawnedAgents`.

**Step 8. Landing.** Last, because a mistake here loses commits.
- **Moves:** the landing mechanism: a detached land worktree at the integration branch, ff or cherry-pick, `merge --ff-only` under a lock, a conflict flag held until the conflicting files move, publish, "land on overlap, not dirt".
- **Here:** `inbox land <sha>` using the adapter's `integrationBranch`, `land`, `publish` and `setup`; a conflict becomes a message to the lane (today's self-heal).
- **FysikLab:** `worktree-sync land` calls `inbox land` behind `LAND_VIA_OFFICE=1`; `worktree-guard`'s bootstrap stays as the adapter's `setup` command.
- **Verify:** on a scratch clone, land ff, cherry-pick and conflict cases; compare with `checkout-landing.mjs` results on the same history.
- **Delete afterwards:** `checkout-landing.mjs`, `worktree-sync.mjs`'s land and publish, `self-heal/conflicts.mjs`, `registry.json`.

What never moves: checks, `gate-scopes`, `check-runtime`, reviewers and `one-review-round` (it asks the service for the caller's slice after step 5), the fix charter, the comment widget and pins, `api/dev/messages` (translations), chapter ids.

## 5. Risks and open questions

**Founder decides:**

1. **Who routes comments.** Keep a Mission Control agent (its judgement, its tokens), or have the service assign by a plain rule (same sim → same lane, else the least loaded). Recommendation: keep the agent; the service stays mechanical.
2. **Where fixes are verified.** Only as pins in FysikLab's pages (today), or also as one Try it item per fix in the Review Inbox so all "go look" is in one queue. Recommendation: pins stay; the inbox shows one daily "N fixes to look at" item linking to them.
3. **What may reach you.** Keep away mode and its four categories plus the 400-character limit as FysikLab policy in the adapter, or let every hold become a normal Decide item. Recommendation: keep them, as adapter settings any project can use.
4. **Landing moves here or stays.** Step 8 makes landing reusable but is the riskiest step; FysikLab's landing works today. Recommendation: decide after step 6 has run for a while.
5. **Usage, quota and Pi harness tweaks.** Pi metrics, the 5-hour-limit pause and compaction are harness concerns, not FysikLab's. Move them into this repo's Pi integration, or leave them in FysikLab. Recommendation: move metrics after step 7; leave the rest.

**Risks and other open questions:**

- **Two writers during a switch.** The daemon and the service must never both assign. Each switch is flipped with nothing in flight, and step 5 keeps a reverse shadow so rollback loses nothing.
- **The service becomes a hard dependency.** Today saving a comment needs only a local file. With step 5, a stopped office means the widget fails to save. Mitigation: the proxy keeps the comment in FysikLab's database and resends it (it has a `requestId`), and `npm run restart-office` restarts the service in one command.
- **Async `comment-store`.** Step 5 turns synchronous calls async across FysikLab's scripts and hooks. A hook that must stay synchronous can call the `inbox` CLI instead.
- **A second pool** (`../.fysiklab-queue/space-shuttle-heisenberg/comments.db`). Import it as its own project or merge it into `fysiklab`; needs checking what it holds.
- **Anchors stay opaque.** The service cannot tell that two anchors are the same place in the lesson; filtering beyond exact top-level keys (FysikLab's "owned here" down to the step) stays in FysikLab's proxy.
- **Lane identity.** FysikLab names lanes `dispatch-<lane>`; the office names agents by harness and checkout. The adapter's `lanes` list is the join; a renamed worktree needs a matching edit there.
- **Shared-machine locks.** `check-runtime`'s machine lease stays in FysikLab; if landing moves (step 8), the land lock and the check lease must not deadlock.
