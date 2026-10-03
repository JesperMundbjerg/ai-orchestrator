# HTTP API

## Contract and trust boundary

The checked agent contract is **protocol version 1**, `AGENT_PROTOCOL_VERSION` in [`src/shared/agent-protocol.ts`](../src/shared/agent-protocol.ts). Its `agentOperations` registry defines methods, paths, request decoders and response decoders; `createAgentClient()` in `src/shared/agent-client.ts` exposes those names plus `switchStatus(id)` and `switches()`. Paths remain unversioned (`/api/...`); there is no `/api/v1` router or version-negotiation header. This reference describes the current checkout, not a promise that every UI projection is a stable external API. Keep existing paths and optional additions compatible; coordinate breaking changes with clients and update this reference/tests rather than silently changing the meaning of a field.

The agent operations (including switch control), reply answer/claim/ack lifecycle, adapter queue read, change stream and evidence URLs are the integration surface. Other office/UI routes below are implementation-facing read models and controls, not a separate versioned SDK. Request/response TypeScript types and executable schemas are authoritative for exact fields.

The service binds `127.0.0.1`; its default port is 4870 (`INBOX_PORT` overrides it). Allowed Hosts are `localhost:<port>` and `127.0.0.1:<port>`. Mutations require `Content-Type: application/json`. A supplied Origin must use an allowed loopback host and port; **no-Origin local CLI/server clients are accepted**. There is no token authentication: session identity isolates routing, not access by other local processes. Do not expose this service through a remote bind or reverse proxy.

## HTTP/error policy

- Routed JSON successes are **200**, including creation and asynchronous switch acceptance.
- A known path with the wrong method returns **405**, with `Allow`; unknown API paths return **404**. SSE is GET-only.
- Empty request bodies decode as `{}`. Otherwise JSON objects are required; malformed known fields are rejected without coercion. Unknown object fields are retained by the decoder but may be ignored by the operation; they are not arbitrary writable properties.
- Optional request fields may be omitted. `null` is accepted only where the schema says so; response DTOs often intentionally contain `null` and empty strings/lists.
- Ordinary JSON bodies are limited to **1,000,000 bytes**. Upload bodies have a separate base64 allowance for a 10 MiB image.

Errors preserve the human-readable `error` string:

```json
{
  "error": "session: identify the session with harness and sessionId, or paneId",
  "code": "invalid_request",
  "details": [{ "path": "session", "message": "identify the session with harness and sessionId, or paneId" }]
}
```

`details` is optional. Field paths use dotted property/index names. Codes are an **open string set**; branch on status and known codes, not English prose. Unexpected failures return a generic `internal_error`, not the internal exception.

| Status | Default code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Shape/type or domain input error; malformed JSON instead uses `invalid_json` |
| 403 | `forbidden` | Host/Origin refused or wrong reviewing team |
| 404 | `not_found` | Missing resource, endpoint or unavailable optional service |
| 405 | `method_not_allowed` | Known path, wrong verb; see `Allow` |
| 409 | `conflict` | Stale revision/round, incompatible state or unsupported control; replay mismatch uses `replay_conflict` |
| 413 | `payload_too_large` | JSON/upload body too large |
| 415 | `unsupported_media_type` | Mutation was not application/json |
| 422 | `invalid_request` | Recognized but unusable project adapter |
| 500 | `internal_error` | Unexpected service failure |
| 502 / 503 | `upstream_error` / `unavailable` | Upstream/service error mapping, when raised |

File range responses have their own status policy (below).

## Identity and submission

A `session` is `{harness, sessionId, cwd?}` or `{paneId, cwd?}` resolved through herdr. Harness is `pi | claude | codex | manual`. Prefer explicit harness and non-empty session id; pane resolution needs available provider observations.

- Pi: **absolute `.jsonl` session-file path**, not the UUID in the file header.
- Claude Code: `CLAUDE_CODE_SESSION_ID`.
- Codex: explicit thread id (or `CODEX_THREAD_ID` when the harness actually exports it).
- Manual: a caller-chosen stable id.

`cwd` supplies checkout context, not authorization. A session task is unique to `(harness, sessionId)`; an office agent's durable identity is a different concept. Repository grouping id, team id and adapter project key are also different: see [ARCHITECTURE.md](ARCHITECTURE.md#glossary).

## Agent operations

Every row is checked by `test/api-reference.test.ts` against `agentOperations`. All requests are JSON objects. A `?` marks an optional field; `session` means the object above.

| Operation | Method | Path | Request (besides session where listed) | Response |
|---|---|---|---|---|
| `submit` | `POST` | `/api/agent/items` | `session`, `project?`, `task?`, `item` | `{itemId, taskId, revision, changed, warnings?}` |
| `activity` | `POST` | `/api/agent/activity` | `session`, `activity?`, `nextMilestone?`, `title?` | `Task` |
| `replies` | `POST` | `/api/agent/replies` | `session`, `mode?: live \| boundary \| pull` | `PendingReply[]` |
| `acknowledge` | `POST` | `/api/agent/ack` | `session`, `deliveryId`, `error?` | `Reply` |
| `team` | `POST` | `/api/agent/team` | `session` | `{agentId, text}` (team brief) |
| `pane` | `POST` | `/api/agent/pane` | `session`, `paneId` (new pane) | `{recorded}` |
| `crew` | `POST` | `/api/agent/crew` | `{}` (no session required) | `{text}` |
| `story` | `POST` | `/api/agent/story` | `session`, `text` | `{story}` |
| `say` | `POST` | `/api/agent/say` | `session`, `to`, `text`, `clientId?` | `Message` |
| `events` | `POST` | `/api/agent/events` | `session`, `events?` | `{ok}` |
| `usage` | `POST` | `/api/agent/usage` | `provider: claude \| codex`, `limits` (no session) | `{changed}` |
| `effort` | `POST` | `/api/agent/effort` | `session`, `report` | `{request: {id, level} \| null}` |
| `handoff` | `POST` | `/api/agent/handoff` | `session`, `summary`, `title?`, `to?`, `work?`, `clientId?` | `{work: Work, message: Message}` |
| `review` | `POST` | `/api/agent/review` | `session`, `work`, `verdict: accept \| changes`, `notes?`, `clientId?`, `round?` | `{work: Work, message: Message}` |
| `withdraw` | `POST` | `/api/agent/withdraw` | `session`, `item` (id or key owned by session) | `Item` |
| `resolve` | `POST` | `/api/agent/resolve` | `session`, `item` (id or key owned by session) | `Item` |
| `qaNext` | `POST` | `/api/agent/qa/next` | `session` (only the chosen QA agent, QA answers on) | `{item: Item & {project, taskTitle} \| null, waiting, toLearn, learnings}` |
| `qaAnswer` | `POST` | `/api/agent/qa/answer` | `session`, `item`, `revision`, `action: choose \| answer \| accept \| request_changes`, `choice?`, `text?`, `reason`, `learnings?` | `Reply` (`answeredBy: qa_agent`) |
| `qaAnswers` | `POST` | `/api/agent/qa/answers` | `session`, `limit?` (only the chosen QA agent) | `{answers: FounderAnswer[], remaining, learnedThrough}` |
| `qaLearned` | `POST` | `/api/agent/qa/learned` | `session`, `through` (a `seq`; the cursor only moves forward) | `{learnedThrough}` |
| `switchAgent` | `POST` | `/api/world/switches` | `agent` (id/name), `to?: claude \| pi`, `model?`, `effort?` (no session) | `AgentSwitch` |
| `switchAll` | `POST` | `/api/world/switches/all-from` | `from: claude \| pi`, `to?`, `model?`, `effort?` (no session) | `{batchId, switches, skipped: [{name, why}]}` |

### Submit/revise

`project?: {name?, root?, objective?}` describes inbox repository grouping; `task?: {title?, objective?}` describes session-task memory. `item` fields:

- Required: `type: decide | try | milestone`, non-empty `title`.
- Optional text: `key`, `request`, `context`, `recommendation`, `check`; `blocking` is boolean (default true for decisions, false otherwise).
- `options`: strings (leading `Label: consequence` is split) or `{id?, label?, consequence?}` objects. A decision accepts zero options (open question) or at least two; exactly one is refused. A recommendation requires choices.
- `preview`: complete http(s) URL string or `{url?, viewport?: desktop | phone | null, setup?}`. `pages`: URL strings (`URL | label | look` syntax supported) or `{url, label?, look?}`. Empty preview objects normalize to no preview.
- `evidence`: `{kind?: image | video | url | document, path?, url?, caption?, sourceRevision?}[]`; at least a path or URL is required.

`(task, key)` is the revision address. Supply a stable key to revise safely; without one the service derives a slug from the title, so title changes can create another item. Identical normalized content/evidence yields `changed: false`. Changed content makes a new positive revision; captured worktree HEAD also contributes to milestone/try revision identity. Queued answers to an older revision become stale. This is **not** message replay: a key intentionally allows changed content.

```sh
curl -sS "http://localhost:${INBOX_PORT:-4870}/api/agent/items" \
  -H 'Content-Type: application/json' \
  -d '{"session":{"harness":"manual","sessionId":"demo","cwd":"/work/garden-notes"},"task":{"title":"Improve navigation"},"item":{"key":"navigation","type":"decide","title":"Which navigation?","options":["Sidebar: stays visible","Tabs: leaves more space"],"recommendation":"Sidebar: stays visible"}}'
```

### Reports, messaging and control

`events` accepts `tool`, `tool_end`, `idle`, `helper_start`, `helper_stop`, `model`, `session_name`, `effort`; optional fields include `tool`, opaque object `input`, `callId`, `helperId`, `helperType`, `model: {id,label}`, nullable `sessionName`, and `effort`. Reports are observations, not permission to execute commands. Activity/helpers/model/session-name reports expire or reset with session/service state.

`effort.report` is `{current, levels: string[], result?: {id, error?}}`. The live integration reports its real level/choices and polls for a session-only command. Confirm using the request id and applied current level; mismatched/clamped or timed-out application fails visibly. The current implementation keeps effort requests/reports **in memory**: restart loses them; do not treat these as durable command receipts.

`usage.limits` entries have finite `usedPercent`, optional `window: five_hour | week`, `windowMinutes`, and `resetsAt` (timestamp, numeric epoch value, numeric string or null). Domain normalization decides which readings are useful. Posting observed readings does not enable authenticated account polling.

A `story` is whitespace-normalized plain text, truncated to 800 Unicode characters on the agent identity record. `pane` records caller-team membership for a newly opened pane; it does not create the pane. `say.to` resolves office agent/team names, `founder`, then adapter lane names. Team recipients are fixed at send time. `handoff` needs a title for new work and another reviewing team (`to` or the sender team's `handsTo`); `work` resubmits existing returned/accepted work as the next round. `review` is allowed only from the receiving team, and `changes` requires notes. Work/verdict and their messages/deliveries/replay records commit together.

Switch calls start a durable asynchronous workflow, not an immediately completed switch. Poll `GET /api/world/switches/:id` or list `GET /api/world/switches`. Steps: `queued`, `waiting`, `handoff`, `opening`, `starting`, `closing`, `taking_over`, `briefing`, `done`, `failed`. Inspect `says` and `error`: recovery-required workflows may remain at their interrupted step with deliveries held, not report `done`. Switch creation has **no replay id**: after a lost response inspect the list before creating another.

## Answer replay and delivery

`POST /api/items/:id/replies` accepts `{id?, revision, action, choice?, text?, images?}`. Actions are `choose`, `answer`, `accept`, `request_changes`, `discuss`; choice must identify an offered option, open answers need text, and requested changes need text. Try and milestone use `accept`/`request_changes`. `discuss` is available on every type. `images` are upload ids, not base64 bytes (null or omission means none). A stale revision returns 409.

### Replay keys

| Mechanism | Semantics |
|---|---|
| Answer `id` | Caller-made reply/delivery id; optional for legacy callers, **retain one for reliable retries**. Fingerprint binds founder answer to item, revision, action, choice, trimmed text and normalized image ids. |
| Message/handoff/review `clientId` | Optional in agent commands and direct founder messages; required for all-leads broadcasts. Binds operation, durable caller agent (or founder), target and normalized content. Same id is not reusable across operations or callers. |
| Review `round` | Positive work-round precondition, defaults to current round. Supply the original round **and** clientId when retrying after a lost response or later round. |

Exact replay returns the stored result, including the handoff/review's original work snapshot; mismatched reuse is **409 `replay_conflict`**, never silent success. A legacy message key without a safe fingerprint is also refused for replay. Without clientId, an exact repeated review by the same reviewer in the same round can return its prior result, but do not rely on that to retry across rounds. Persist the id **before** sending; on timeout repeat the same operation/content/id, not a freshly generated id. The service never blindly retries a potentially accepted terminal prompt.

### Claim/ack lifecycle

1. Answering creates a `queued` reply addressed to the exact owning harness/session.
2. `replies` is POST because it **claims replies and learns delivery capability**. Mode defaults to `pull`; `live` is fresh for 15 seconds and boundary activity learns `boundary`. A poll does not confirm receipt or delete a reply.
3. Integration claims can be returned again until ack: deduplicate by `deliveryId` in the same session. Only acknowledge success after actual receipt, not after invoking a fire-and-forget send function. Success ack is `{session, deliveryId}`; definite failure includes non-empty `error`.
4. A claimed reply with no acknowledgement after 30 seconds projects as `uncertain`. Failed replies return the item to Needs you; `POST /api/replies/:id/retry` explicitly queues another attempt. Retry may duplicate an unconfirmed receipt.
5. For a free idle/done pane without a fresh live integration, the office may claim the reply durably for terminal delivery. Pane claims cannot be read or acknowledged by a hook/pull integration. They count as delivered only when herdr observes uptake. Restart marks interrupted pane/legacy-unknown claims failed with a may-have-arrived warning; it never reroutes them automatically. Integration claims retain re-poll/deduplication semantics after restart.
6. Revision changes make old queued replies stale. Ack of a reply not owned by that session returns 404; ack of a stale/non-queued reply is refused with 409. Delivered ack is idempotent.

## Other implemented routes

These routes use `src/server/request-validation.ts` and domain DTOs in `src/shared/types.ts`; they share the guards/error policy above. No speculative comment/fix/landing routes exist.

| Method/path | Purpose / request |
|---|---|
| `GET /api/state`; `GET /api/items/:id` | Inbox projection; item detail/history |
| `GET /api/auto-approve`; `POST /api/auto-approve` | Inbox-only persisted automation state `{enabled, count, mode, qa}`; set `{mode: off \| approve_all \| qa, agentId?}` (the QA agent) or the older `{enabled: boolean}` (off by default). QA answers need an agent; `qa` reports it with `online`, `withQa`, `answered`, `overridden` |
| `POST /api/items/:id/replies` | Answer, as above |
| `POST /api/items/:id/snooze` | `{until: timestamp}` |
| `POST /api/items/:id/back-of-queue` | `{}`; the founder moves an item that needs them behind every other waiting item. It stays `needs_attention` (not snoozed, not resolved), no reply is created and nothing is sent to the agent. Returns the item with `backedAt` set; 409 unless it is `needs_attention`. Logged as the item event `item.backqueued`. Order rule in [DESIGN](DESIGN.md#layout) |
| `POST /api/items/:id/resolve` | `{}`; mark handled without an agent reply |
| `GET /api/items/:id/preview-check`; `GET /api/items/:id/pages/:index/check` | Reachability/framing check of item's own URL, zero-based index |
| `POST /api/replies/:id/retry` | `{}`; explicit delivery retry |
| `PATCH /api/tasks/:id` | Optional `title`, `objective`, `activity`, `nextMilestone`, `lastDecision`, `lastAcceptedMilestone`, `parked` |
| `POST /api/tasks/:id/open` | `{}`; herdr focus |
| `POST /api/projects/:id/pin` | `{pinned: boolean}`; inbox repository grouping |
| `POST /api/uploads` | `{data: base64-image-data-URL}` → `{id,url,size}` |
| `GET /api/world` | Office projection (includes reconciliation; not a pure read) |
| `GET /api/p/:project/queue` | Adapter lane projection; [ORCHESTRATION.md](ORCHESTRATION.md) |
| `GET /api/lanes` | Every adapter lane that declares `attach`, as `StandingLane`: `state` (`checking`, `connected`, `disconnected`, `busy`, `unknown`), `reason`, the registered session and its office agent, recovery `candidates`, and the last `recovery`. Reading runs the lane's status command when its last check is over 30 s old |
| `POST /api/p/:project/lanes/:lane/check` | `{}`; runs the lane's status command now and returns the `StandingLane` |
| `POST /api/p/:project/lanes/:lane/recover` | `{agentId}`; the founder's explicit recovery onto a running agent in the lane's checkout. 409 while one runs for that lane or when the agent does not run there. Returns the `StandingLane` with `recovery.state` `attached`, `busy`, `unavailable`, `refused` or `failed` and the command's reason |
| `POST /api/world/teams` | `name`, optional `purpose`, nullable `handsTo`, `repository`, boolean `standing` |
| `PATCH /api/world/teams/:id`; `DELETE /api/world/teams/:id` | Update optional `name`, `purpose`, nullable `handsTo`; finish/delete with safety checks |
| `GET /api/world/teams/:id/worktrees` | Additional owned worktree records |
| `POST /api/world/teams/:id/worktrees`; `POST /api/world/teams/:id/worktrees/remove` | `{path}`; record/release ownership, not disk creation/deletion |
| `POST /api/world/teams/:id/merge` | `{into: teamId}`; fold records without touching disk/panes |
| `POST /api/world/teams/:id/messages`; `POST /api/world/agents/:id/messages` | `{text?, images?, clientId?}`; at least text or images |
| `POST /api/world/all-leads/messages` | `{text?, images?, clientId, leadIds?}`; omit leadIds for all leads; fixed recipients, atomic broadcast |
| `POST /api/world/messages/:message/deliveries/:agent/retry` | `{}`; explicit live-recipient retry |
| `PATCH /api/world/agents/:id`; `DELETE /api/world/agents/:id` | Optional `name`, nullable `teamId`, `role: lead \| member`, `takeName`; remove offline agent |
| `POST /api/world/agents/:id/effort` | `{level}`; live session-only control |
| `GET /api/world/crew-tree`; `PUT /api/world/crew-tree` | Read/replace validated version-1 `CrewTree` (`src/shared/crewtree.ts`) |
| `GET /api/world/switches`; `GET /api/world/switches/:id` | Durable switch progress; creation operations listed above |
| `GET /api/machine`; `POST /api/machine/browsers/:pid/close` | Machine projection; `{}` to close verified listed headless main process (404 when cleanup integration disabled) |
| `POST /api/hooks/claude` | Extensible native hook input; validates consumed fields; returns `{}`, never a harness allow/deny decision |

### Pipeline runs

Pipeline routes use domain decoders in `src/server/pipelines/protocol.ts` and DTOs in `src/shared/pipeline.ts`, not the version-1 `agentOperations` registry. They share the HTTP guards and error policy above.

| Method/path | Request / response |
|---|---|
| `GET /api/world/teams/:id/pipeline` | `PipelineTeamView`, including retained runs |
| `POST /api/agent/pipeline/status` | `{session, runId?}` → `{team, run, text}`; omitted runId selects an open run only, or null |
| `POST /api/agent/pipeline/branch` | `{session, runId, clientId, selections, rationale, expectedRevision?, base?, candidate?}` → `PipelineRun` |
| `POST /api/agent/pipeline/abandon` | `{session, runId, clientId, notes}` → `PipelineRun` |
| `POST /api/agent/pipeline/gate` | `{session, runId, delivery, round, candidate, ...}` → `{allowed, runId, round, candidate, reasons}` |
| `POST /api/agent/pipeline/waiver` | `{session, clientId, repo, ref, candidate, reason}` → `PipelineWaiver` (`src/shared/waiver.ts`); the lead, or anyone while the team has no lead online; one founder inbox decision per waiting commit/branch/base |
| `POST /api/agent/pipeline/waiver/gate` | `{session, repo, ref, candidate, operation?}` → `{allowed, waiverId, candidate, reasons}`; a delivery that names no run, allowed only by a founder-granted waiver |
| `GET /api/world/teams/:id/pipeline/waivers` | the team repository's `PipelineWaiver[]`, newest first |

`branch` requires the run team's current first mate, including on replay retrieval. Ordinary selection/re-pin edits require `expectedRevision`; a re-base with `base` may omit it so CLI retries do not acquire a newer revision. `selections` is an object (use `{}` to retain current choices), and non-empty `rationale` is required. `candidate` defaults to the owned checkout's HEAD when re-basing. The new base must be reachable from a remote-tracking `dev` (or adapter `integrationBranch`) ref and ancestral to the candidate; a local branch is insufficient. Failure returns 409 `pipeline_base_unpublished` or `pipeline_base_not_ancestor`. No network fetch or Git writes occur.

Re-base recomputes `candidate.base`, `changedPaths` and the scoped intended-bytes `fingerprint` (`fingerprintVersion: 2`) before path guards. Unchanged own bytes preserve evidence/round; changed scope makes old evidence stale and increments the round. Legacy whole-tree candidates retain their old semantics until re-base, which conservatively invalidates their evidence. `rebases?: [{oldBase, newBase, notes, byAgentId, at}]` records the history, also shown in Runs and briefings. Closed runs reject new edits. History, run update, audit event and replay receipt are atomic; exact same caller/payload/clientId returns the original result after restart, mismatches return 409 `replay_conflict`.

Graph nodes may add `binding: "run" | "candidate"` (default candidate; conditions are run concepts). Explicit run-bound report/artifact steps accept evidence despite changing live candidate bytes. Their evidence adds `binding: "run"`; `fingerprint` is then a run/scope identity token, and `round` must still match. `scopeRevision?: number` on the run increments when selections change, invalidating old run-bound evidence without allowing revival when choices toggle back. New rounds invalidate both bindings. Checks, reviews, approvals and delivery cannot use run binding; final gate candidate freshness is unchanged. Binding is preserved by graph validation and shown in Runs/briefings; prose/step names never imply it.

`abandon` requires non-empty notes and a replay id, and only the run team's **current first mate** may call it (403 `pipeline_lead_required` otherwise). An open run becomes terminal `abandoned`; delivered or already-abandoned runs reject new closure requests with 409. The returned run adds `abandonment: {notes, byAgentId, at}` alongside `state: "abandoned"`. Existing graph, candidate, selections, step dispositions, evidence and bindings are retained; this does not delete files, deliver work or turn off protection. The gate returns `allowed: false` for abandoned runs, and editing/presentation is refused. Automatic briefings no longer offer the run; explicit status retains its reason and evidence.

Closure, audit event and replay receipt are one transaction. Exact retries return the stored result after restart; mismatched id reuse returns 409 `replay_conflict`. There is no `expectedRevision` for abandon: it closes the currently open run, so the same CLI command with `--client-id` can be replayed without deriving a new revision. Current-lead authorization is rechecked even on receipt retrieval. See [PIPELINES.md](PIPELINES.md) for CLI usage and delivery-hook boundaries.

### Change stream

`GET /api/events` is a global invalidation stream, not an event log:

```text
retry: 2000

event: changed
data: {"reason":"inbox"}

```

The reason is a hint, not a closed enum. Comment pings arrive every 25 seconds. Refetch relevant full state on a change and after reconnect. There are **no event ids, cursor replay, Last-Event-ID recovery or project filters**. A `?project=` query does not scope it.

### Evidence and images

Submission `evidence.path` explicitly copies a local file into the data directory. The file must be regular (not a symlink) and its basename must not start with a dot; extension allowlist: PNG/JPEG/WebP/GIF, MP4/WebM/MOV, PDF/Markdown/text. Unlike projector excerpts, explicit attachments are not a credential-content scanner: inspect what you submit. General attachments are at most 20 MiB; videos at most 200 MiB. URL evidence is a link, not a copied file. Copies belong to their revision and remain outside worktrees.

`GET /files/:evidenceId` and `HEAD /files/:evidenceId` serve resolved evidence with sandbox CSP, nosniff and inline disposition. Single byte ranges return 206; unsatisfiable ranges return 416; unsupported/malformed ranges and `If-Range` fall back to the full response. HEAD returns full-representation headers without a body.

Pasted images use `POST /api/uploads`; bytes must really be PNG, JPEG, GIF or WebP and at most 10 MiB. Up to eight image ids can be attached to a message/answer. `GET /uploads/:id` serves the stored image with sandbox CSP and immutable private caching (no HEAD/range API). Agents receive absolute image paths, not image bytes in terminal text. There is no automatic retention/deletion API: back up SQLite, files and uploads together.

## Checks

`test/api-reference.test.ts` guards operation names/methods/paths against registry drift. Behavioral coverage: `test/http-contract.test.ts` (validation/methods/errors), `test/api-replay.test.ts` (keys/conflicts/atomic work), `test/typed-replies.test.ts` and `test/inbox.test.ts` (claim/recovery/revisions), `test/agent-client.test.ts` (typed client/errors), `test/pi-delivery.test.ts` (actual receipt boundary). These are isolated tests, not certification of every real harness/provider release.
