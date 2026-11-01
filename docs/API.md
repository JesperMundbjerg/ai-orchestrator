# HTTP API

## Contract and trust boundary

The checked agent contract is **protocol version 1**, `AGENT_PROTOCOL_VERSION` in [`src/shared/agent-protocol.ts`](../src/shared/agent-protocol.ts). Its `agentOperations` registry defines methods, paths, request decoders and response decoders; `createAgentClient()` in `src/shared/agent-client.ts` exposes those names plus `switchStatus(id)` and `switches()`. Paths remain unversioned (`/api/...`); there is no `/api/v1` router or version-negotiation header. This reference describes the current checkout, not a promise that every UI projection is a stable external API. Keep existing paths and optional additions compatible; coordinate breaking changes with clients and update this reference/tests rather than silently changing the meaning of a field.

The agent operations (including switch control), reply answer/claim/ack lifecycle, adapter queue read, change stream and evidence URLs are the integration surface. Other office/UI routes below are implementation-facing read models and controls, not a separate versioned SDK. Request/response TypeScript types and executable schemas are authoritative for exact fields.

The service binds `127.0.0.1`; its default port is 4870 (`INBOX_PORT` overrides it). Allowed Hosts are `localhost:<port>` and `127.0.0.1:<port>`. Mutations require `Content-Type: application/json`. A supplied Origin must use an allowed loopback host and port; **no-Origin local CLI/server clients are accepted**. There is no token authentication: session identity isolates routing, not access by other local processes. Do not expose this service through a remote bind or reverse proxy. Pages on other origins reach the office only through the embedded widget ([Page comments](#page-comments)); the guard makes no exception for them.

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
| `switchAgent` | `POST` | `/api/world/switches` | `agent` (id/name), `to?: claude \| pi`, `model?`, `effort?`, `handoff?: boolean` (no session) | `AgentSwitch` |
| `switchAll` | `POST` | `/api/world/switches/all-from` | `from: claude \| pi`, `to?`, `model?`, `effort?`, `handoff?` (no session) | `{batchId, switches, skipped: [{name, why}]}` |

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

`usage.limits` entries have finite `usedPercent`, optional `window: five_hour | week`, `windowMinutes`, and `resetsAt` (timestamp, numeric epoch value, numeric string or null). A Codex entry may carry `credits: {hasCredits, unlimited, balance}` (each a boolean, a boolean and a finite number, or null), what the same reply said of the account's credits; `WorldState.usage` shows the latest on the `codex.week` meter as `credits: {label, left, balance, unlimited, asOf, stale, inUse}`, with `left: null` while unknown. Domain normalization decides which readings are useful. Posting observed readings does not enable authenticated account polling.

A `story` is whitespace-normalized plain text, truncated to 800 Unicode characters on the agent identity record. A story whose opening sentence is a frame or disclaimer (a label such as `Backstory:`, fictional, imagined, office story, persona, being an AI or a language model, having no childhood; case and punctuation ignored) is refused with 400, telling the agent to retell it plainly as its own life, and nothing is saved. `pane` records caller-team membership for a newly opened pane; it does not create the pane. `say.to` resolves office agent/team names, `founder`, then adapter lane names. Team recipients are fixed at send time. `handoff` needs a title for new work and another reviewing team (`to` or the sender team's `handsTo`); `work` resubmits existing returned/accepted work as the next round. `review` is allowed only from the receiving team, and `changes` requires notes. Work/verdict and their messages/deliveries/replay records commit together.

Switch calls start a durable asynchronous workflow, not an immediately completed switch. Poll `GET /api/world/switches/:id` or list `GET /api/world/switches`. Steps: `queued`, `waiting`, `handoff`, `opening`, `starting`, `closing`, `taking_over`, `briefing`, `done`, `failed`. Inspect `says` and `error`: recovery-required workflows may remain at their interrupted step with deliveries held, not report `done`. `handoff: false` (CLI `--no-handoff`) is for an agent that cannot answer, such as one whose model is unavailable: the old session is never prompted or waited for; the office writes a factual handoff itself (no model call: name, team, role, lane, checkout, branch, HEAD, `git status --short`, the old transcript's path, open inbox items, undelivered messages) and the switch goes on to `opening` as usual. Omitted or `true` asks the agent, as before; an asked handoff that times out fails with a hint to retry with `--no-handoff`. Switch creation has **no replay id**: after a lost response inspect the list before creating another. When the new session takes over and stands behind a standing lane of a project whose `orchestrator.json` declares `laneRouting`, the lane's runtime and model are also written to that project's override for its next start ([DESIGN](DESIGN.md#the-office)); the switch's own result does not change.

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
| `GET /api/auto-approve`; `POST /api/auto-approve` | Inbox-only persisted automation state; `{enabled: boolean}` (off by default) |
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
| `PATCH /api/world/teams/:id`; `DELETE /api/world/teams/:id` | Update optional `name`, `purpose`, nullable `handsTo`; finish/delete with safety checks. Finishing work that has not landed is 409 `finish_uncommitted` (anything uncommitted; always) or `finish_unlanded` (commits not on the integration branch), and tells the project's lead to land it; DELETE body `{ "force": true }` finishes past `finish_unlanded` only and keeps the branch |
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
| `GET /api/pipeline/telemetry?run=&team=&kind=&since=&limit=` | `PipelineTelemetryView`: `{coverageStartedAt, coverageSchemaVersion, schemaVersion, events, decisionWaits, dropped}`; read-only, no session (see below) |
| `POST /api/agent/pipeline/telemetry/log` | `{session, kind: "lease"\|"attempt", ...}` → `{recorded: kind}`; an externally reported capture lease or attempt, strictly validated (see below) |

`branch` requires the run team's current first mate, including on replay retrieval. Ordinary selection/re-pin edits require `expectedRevision`; a re-base with `base` may omit it so CLI retries do not acquire a newer revision. `selections` is an object (use `{}` to retain current choices), and non-empty `rationale` is required. `candidate` defaults to the owned checkout's HEAD when re-basing. The new base must be reachable from a remote-tracking `dev` (or adapter `integrationBranch`) ref and ancestral to the candidate; a local branch is insufficient. Failure returns 409 `pipeline_base_unpublished` or `pipeline_base_not_ancestor`. No network fetch or Git writes occur.

Re-base recomputes `candidate.base`, `changedPaths` and the scoped intended-bytes `fingerprint` (`fingerprintVersion: 2`) before path guards. Unchanged own bytes preserve evidence/round; changed scope makes old evidence stale and increments the round. Legacy whole-tree candidates retain their old semantics until re-base, which conservatively invalidates their evidence. `rebases?: [{oldBase, newBase, notes, byAgentId, at}]` records the history, also shown in Runs and briefings. Closed runs reject new edits. History, run update, audit event and replay receipt are atomic; exact same caller/payload/clientId returns the original result after restart, mismatches return 409 `replay_conflict`.

Graph nodes may add `binding: "run" | "candidate"` (default candidate; conditions are run concepts). Explicit run-bound report/artifact steps accept evidence despite changing live candidate bytes. Their evidence adds `binding: "run"`; `fingerprint` is then a run/scope identity token, and `round` must still match. `scopeRevision?: number` on the run increments when selections change, invalidating old run-bound evidence without allowing revival when choices toggle back. New rounds invalidate both bindings. Checks, reviews, approvals and delivery cannot use run binding; final gate candidate freshness is unchanged. Binding is preserved by graph validation and shown in Runs/briefings; prose/step names never imply it.

`abandon` requires non-empty notes and a replay id, and only the run team's **current first mate** may call it (403 `pipeline_lead_required` otherwise). An open run becomes terminal `abandoned`; delivered or already-abandoned runs reject new closure requests with 409. The returned run adds `abandonment: {notes, byAgentId, at}` alongside `state: "abandoned"`. Existing graph, candidate, selections, step dispositions, evidence and bindings are retained; this does not delete files, deliver work or turn off protection. The gate returns `allowed: false` for abandoned runs, and editing/presentation is refused. Automatic briefings no longer offer the run; explicit status retains its reason and evidence.

Closure, audit event and replay receipt are one transaction. Exact retries return the stored result after restart; mismatched id reuse returns 409 `replay_conflict`. There is no `expectedRevision` for abandon: it closes the currently open run, so the same CLI command with `--client-id` can be replayed without deriving a new revision. Current-lead authorization is rechecked even on receipt retrieval. See [PIPELINES.md](PIPELINES.md) for CLI usage and delivery-hook boundaries.

#### Pipeline telemetry (read-only)

`GET /api/pipeline/telemetry` (CLI: `inbox pipeline telemetry [RUN] [--team TEAM --kind K --since ISO --limit N]`, which prints the JSON) reads what the office records about delivery. It authorizes nothing and is never consulted by a gate. All query parameters are optional: `run` (run id), `team` (the run's team id), `kind` (`gate`, `integration`, `publication`, `lease` or `attempt`), `since` (ISO time, inclusive) and `limit` (1–1000, default 200). Any other value is a 400.

Response: `PipelineTelemetryView` = `{coverageStartedAt, coverageSchemaVersion, schemaVersion, events, decisionWaits, dropped}`. `events` is newest first, each `{id, at, kind, runId, teamId, detail}`. Rows are `events` table rows with kind `pipeline.telemetry.<kind>`; `runId` and `teamId` are stored in `detail` and lifted out on read. Every record kind and its fields (schema version 1):

| Record | Stored as | Fields |
|---|---|---|
| **Coverage start** | `pipeline.telemetry.started`, once per data directory, never pruned; returned as `coverageStartedAt` / `coverageSchemaVersion`, not in `events` | `{schemaVersion}` and the row time; null until written. Before `coverageStartedAt` the logged kinds (gate, integration, publication, lease, attempt) were not measured: read earlier time as *not measured*, never as zero. Decision waits are derived from history and are valid before it too. |
| **Gate result** (allowed and refused) | `pipeline.telemetry.gate` | `agentId`, `delivery` (`dev`/`handoff`/`review`), `node` (internal review step or null), `operation` (`push`/`pr`/`merge`/`land`/`publish` or null), `ref`, `round`, `candidate`, `outcome` (`allowed`/`refused`), `reasons: [{code, node?}]` (empty when allowed), `text?: string[]` (refusal messages, at most 12 × 300 chars), `repeats` (count, at least 1), `lastAt?` (latest repeat) |
| **Integration** | `pipeline.telemetry.integration` | `agentId`, `changes: ("rebase"/"repin"/"rebranch"/"unchanged")[]`, `round`, `roundBumped`, `scopeRevision`, `oldBase`, `newBase`, `oldHead`, `newHead`, `fields` (changed selection fields) |
| **Publication pending** | `pipeline.telemetry.publication`, `state: "pending"` | `round`, `candidate`, `operation`, `ref` |
| **Publication resolved** | `pipeline.telemetry.publication`, `state: "resolved"` | `how` (`landed`/`superseded`/`abandoned`), `candidate`, `pendingId`, `pendingSince`, `waitMs`, `ref?` and `tip?` (landed) |
| **Decision wait** | not stored: derived on read into `decisionWaits` | `runId`, `itemId`, `revision`, `type`, `blocking`, `stepId` (step whose evidence endorses it, or null), `waitingSince`, `answeredAt` (or null), `action` (`accept`/`request_changes`/null), `automatic` (approve-all), `waitMs` (null while waiting) |
| **Capture lease** (reported) | `pipeline.telemetry.lease` | `action` (`grant`/`release`/`expire`), `lease`, `holder`, `resource?`, `reportedAt?` (the reporter's `--at`, normalized to UTC), `agentId` and `agentTeamId` (the reporting agent, resolved by session), `repeats`, `lastAt?`; `runId` (`--run`, must exist) and `teamId` (that run's team) or null |
| **Capture attempt** (reported) | `pipeline.telemetry.attempt` | `attempt`, `lease?`, `outcome` (`started`/`succeeded`/`failed`/`abandoned`), `reason?`, `reportedAt?`, `agentId`, `agentTeamId`, `repeats`, `lastAt?`; `runId`/`teamId` as for a lease |
| **Capture lease** (office-run) | `pipeline.telemetry.lease`, `source: "office"` | `action` (`grant`/`join`/`leave`/`renew`/`release`/`expire`/`revoke`), `lease` (one id from queue join to release), `holder` (the holder's or waiter's name), `agentId`, `resource` (`capture`), `repo` (Git common dir), `purpose?` (the acquire `--reason`), `waitMs` (grant: queue join to grant, 0 when free), `expiresAt` (grant/renew), `heldMs` (release/expire/revoke), `waitedMs` (leave), `position` (join), `reason` (release `gone`; leave `left`/`gone`; revoke's reason), `by`/`byAgentId` (revoke), `repeats`; `runId`/`teamId` from the acquire's `--run` or null |

Semantics:

- **Gate result**: one row per pipeline gate answer, whether from `POST /api/agent/pipeline/gate` (hooks, CLI) or from a protected handoff/review (`requireDelivery`), including refusals thrown before or during evaluation. Reason codes: `run_archived`, `run_closed`, `stale_round`, `stale_candidate`, `uncommitted_candidate`, `candidate_unavailable`, `pipeline_unavailable`, `selection_missing`, `path_scope`, `not_review_step`, `no_boundary`, `step_<state>` (with `node`; for example `step_ready`, `step_stale`), `work_round_mismatch`, `operation_incomplete`, `operation_unsupported`, `operation_repo_mismatch`, `operation_repo_unavailable`, `ref_not_protected`, `gate_required`, `other_team_run`, the thrown error's code (for example `pipeline_lead_required`, `pipeline_stale_round`) or `http_<status>`. The same result for the same run, agent and request within 10 minutes increments `repeats` on its row instead of adding one. Exact-SHA waiver gates are not included; their refusals stay `pipeline.waiver.gate_refused`.
- **Integration**: one row per committed `branch` edit; a replayed request records nothing. `rebranch` means the selections changed (`scopeRevision` incremented).
- **Publication**: pending when a gate first allows a dev `push`, `land` or `publish` for that run's candidate. It resolves when the office sees the candidate on the published branch (`landed`), the run is re-pinned to another commit (`superseded`) or the run is abandoned. The office does not see a push fail, so a pending row that never resolves is what that looks like.
- **Capture lease (office-run)**: every change to an office-run capture lease (below), written after the lease change commits; a failing write is only counted in `dropped`.
- **Capture lease and attempt (reported)**: leases granted outside the office, and capture attempts, are reported from outside. Whoever grants a capture lease logs each grant and release, and the project's capture tooling logs each attempt, with `inbox pipeline telemetry log` (below). The row's `at` is when the office received it. The same report again within 10 minutes increments `repeats`. No gate, edit or delivery reads them.
- **Decision wait**: for each founder approval item revision a run presented (`pipeline_item_bindings`), the wait from that revision's creation to the founder's first Accept or Needs changes on it. A discussion message is not an answer, and snoozed time is not subtracted. Omitted (`[]`) when `kind` is given.

Reporting a capture lease or attempt:

```sh
inbox pipeline telemetry log --kind lease --action grant|release|expire --lease ID --holder NAME [--run RUN] [--resource TEXT] [--at ISO]
inbox pipeline telemetry log --kind attempt --attempt ID --outcome started|succeeded|failed|abandoned [--lease ID] [--run RUN] [--reason CODE] [--at ISO]
```

The CLI is fire-and-forget. It gives up after 2 s and always exits 0. When the office is down, slow or refuses the event, or the flags are wrong, it prints `inbox: telemetry not recorded (continuing): …` on stderr, so a capture or delivery never waits on it or fails because of it. It sends `POST /api/agent/pipeline/telemetry/log` with the flags as fields plus `session`. Only these fields are accepted; any other field, or a value outside its rule, is a 400 `invalid_request`:

| Field | Rule |
|---|---|
| `kind` | `lease` or `attempt` |
| `action` (lease, required) | `grant`, `release` or `expire` |
| `lease` (lease required; attempt optional), `attempt` (attempt, required), `run` (optional) | 1–128 of letters, digits, `_ . : @ / -` |
| `holder` (lease, required) | non-empty, at most 200 characters |
| `resource` (lease, optional) | non-empty, at most 500 characters |
| `outcome` (attempt, required) | `started`, `succeeded`, `failed` or `abandoned` |
| `reason` (attempt, optional) | lowercase code: `[a-z0-9][a-z0-9_.-]{0,63}` |
| `at` (optional) | ISO time with date and time, for example `2026-10-03T10:00:00Z` |

A `run` that does not exist is a 404. An unknown session is refused as for any agent route.

`dropped` counts telemetry notes this office process could not write (queue full, or a failed write) since it started. Recording is bounded for every kind, reported ones included: a queue of at most 500 notes and the newest 20,000 rows (the coverage marker excepted).

### Capture lease

One office-run lease per repository and resource, keyed by the repository's Git common dir, so every checkout, lane and team of it shares it (`src/server/leases.ts`, decoders in `src/server/leases-protocol.ts`, DTOs in `src/shared/leases.ts`; not in the `agentOperations` registry). The only resource is `capture`: the project's one headless checker (probe/take captures, `npm run check`, full browser tests). The caller is resolved by session; the repository from `repo` (any path inside a checkout) or else the session's `cwd`. Every request runs expiry and gone-holder checks for that lease first, and answers `LeaseResult` = `LeaseView & {you: {state: "held"|"queued"|"none", position, leaseId}, text}`, where `LeaseView` = `{resource, repo, root, project, holder: {agentId, name, leaseId, since, expiresAt, runId, reason} | null, queue: [{agentId, name, leaseId, position, since, runId, reason}], holdMinutes, lead: {agentId, name} | null}`. Any field not listed is a 400.

| Method/path | Request / response |
|---|---|
| `POST /api/agent/lease/acquire` | `{session, resource, repo?, run?, reason?}` → `LeaseResult`; granted at once when free, else the caller joins the FIFO queue. Idempotent while held or queued. `run` must exist (404 `lease_run_unknown`) and belong to the caller's team (403 `lease_run_other_team`) |
| `POST /api/agent/lease/release` | `{session, resource, repo?}` → `LeaseResult`; the holder only (403 `lease_not_holder`); the first in line is granted and told |
| `POST /api/agent/lease/leave` | `{session, resource, repo?}` → `LeaseResult`; leaves the queue (no-op when not in it; 409 `lease_held` for the holder) |
| `POST /api/agent/lease/renew` | `{session, resource, repo?}` → `LeaseResult`; the holder only; expiry becomes now + the hold limit |
| `POST /api/agent/lease/status` | `{session, resource, repo?}` → `LeaseResult` |
| `POST /api/agent/lease/revoke` | `{session, resource, repo?, reason}` → `LeaseResult`; the repository's lead only (403 `lease_lead_required`); 409 `lease_free` when nobody holds it |
| `POST /api/agent/lease/limit` | `{session, resource, repo?, minutes}` → `LeaseResult`; the repository's lead only; 1–240 minutes, applied from the next grant or renewal (default 30) |
| `GET /api/world/teams/:id/lease` | `{lease: LeaseView \| null}` for the team's repository; read-only, null when it has never been used |

CLI (exits 0 when you hold it, 3 while you wait in line; `--json` prints the result):

```sh
inbox lease acquire capture [--run RUN] [--reason TEXT] [--wait SEC]   # --wait polls by re-acquiring, at most 120 s
inbox lease release|renew|leave|status capture
inbox lease revoke capture --reason TEXT
inbox lease limit capture --minutes N
#   common: --repo PATH
```

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

## Page comments

A stable, vendor-neutral surface for commenting from any web page to any team, owned end to end by the office. A page lists teams and names one **by id**, never by name. It makes **one call to queue a comment**; from then on the office owns it: it stores the comment in its own queue (`page_comments`), gives it to the team's lead as an ordinary founder instruction (`Messages.instruct`: queued while the lead is busy or away, batched with what else waits, never typed twice), tracks it, and tells the page every status change. The lead closes the loop with `inbox comment fixed|declined`. Types and pure helpers: [`src/shared/pagecomments.ts`](../src/shared/pagecomments.ts); behavior: [`src/server/pagecomments.ts`](../src/server/pagecomments.ts); tests: `test/pagecomments.test.ts`, `test/pagecomments.browser.mjs`.

**Status:** `queued` → `delivered` → `working` → `fixed` | `declined`, or `failed` when it cannot be delivered.

- `queued`: in the office's queue, or given to the lead and waiting until they are free or back. A team with nobody on it keeps it queued (`note` says why) until someone leads it.
- `delivered`: the lead took the prompt up.
- `working`, `fixed`, `declined`: set by the fixer. `fixed` and `declined` are final; repeating the same close is fine, a different one is 409 `comment_closed`. `declined` needs a note.
- `failed`: the delivery failed in a way that may already have arrived (the office never replays those; the founder's Retry in the office delivers it and the comment moves on to `delivered`), the team is gone, or a lead that left before it arrived was tried three times (`MAX_ATTEMPTS`). A delivery that failed because its lead left is given to the team again.

| Method/path | Purpose / request |
|---|---|
| `GET /api/page-comments/teams` | `{teams: PageTeam[]}` ordered by name: `{id, name, purpose, status: blocked \| working \| idle \| offline, lead: {name, online} \| null, leadPresent}`. No paths or branches |
| `POST /api/page-comments/teams/:id/comments` | Queue one comment: `{text?, page?, openUrl?, meta?, images?, clientId?}` → the `PageComment`. Text or images required (text under 6000 characters). `page` is `{url?, title?, selector?, anchor?, selectedText?, viewport?}`; unknown fields are dropped and each is one line clipped to `PAGE_CONTEXT_LIMITS`; `url` must be http(s). `openUrl` (http(s), under 1000 characters) is where the page should go to show the fix. `meta` is a JSON object of at most 2048 bytes, stored and handed back untouched with every event (page-specific fields; the office never reads it). `images` are ids from `POST /api/uploads`. The same `clientId` returns the first comment and queues nothing; reused for a different comment it is 409 `replay_conflict`. Unknown team id: 404 |
| `GET /api/page-comments` | `{comments: PageComment[]}`, newest first; query `team`, `origin`, `ids` (comma-separated), `status`, `limit` (default 100, at most 500) |
| `GET /api/page-comments/:id` | One `PageComment`: `{id, teamId, teamName, text, page, origin, openUrl, meta, images, status, note, commit, by, messageId, attempts, createdAt, updatedAt}`. `origin` is the page's origin, from `page.url` or else `openUrl`. `openUrl` is the fixer's url when given, else the page's own |
| `POST /api/page-comments/:id/status` | The fixer: `{status: working \| fixed \| declined, note?, url?, commit?, session?}`. `url` (http(s)) overrides `openUrl`; `commit` is a SHA; `session` records who (`by`). Returns the `PageComment` |
| `GET /api/page-comments/events` | Server-sent events, `event: comment`, `data: PageCommentEvent` (`{id, teamId, status, openUrl, note, commit, meta, updatedAt}`), on every status change of a matching comment. Query `team`, `origin`, `ids` filter; on connect it first sends the current state of the newest `limit` (50) matches, so a reconnect catches up. Pings every 25 s |
| `GET /api/page-comments/origins`; `PUT /api/page-comments/origins` | The page origins allowed to host the widget: `{origins: string[], default: boolean}`. Until the founder saves a list it is `http://localhost:*` and `http://127.0.0.1:*` (`default: true`). PUT `{origins}` replaces it; each entry is `scheme://host`, `scheme://host:port` or `scheme://host:*` (http/https; no paths, no host wildcards), else 400. Stored in `page-comments.json` in the data directory; a damaged file allows no page |

The lead reads the context first, compactly, then the comment, where to open it and how to close it:

```text
[From the founder to Mission Control] …
[Page comment]
On "Orbits" http://localhost:3000/lessons/orbits#chart
At: element main .chart > button · #chart · viewport 390x844 phone
Selected: "Launch"

The button overlaps the chart on phones.

Open to check: http://localhost:3000/lessons/orbits?step=2

Page comment pc-3f9a1c2b7d. Say `inbox comment working pc-3f9a1c2b7d` when you start; when it is fixed, `inbox comment fixed pc-3f9a1c2b7d [--url URL] [--note "…"] [--commit SHA]` …; if it will not be fixed, `inbox comment declined pc-3f9a1c2b7d --note "why"`. The page that sent it is told.
```

The CLI (`inbox comment working|fixed|declined|show ID`) calls the status route with the agent's session; the founder may run it from any shell.

**From a backend** (no `Origin` header, like the CLI), call the routes above directly: read the team list once and keep the chosen team's **id**, POST each comment with a `clientId`, and listen on `GET /api/page-comments/events?origin=…` (or `?ids=…`).

**From a browser page on another origin**, the API is not callable: the Origin guard refuses it (403), and that does not change; the page cannot read the event stream either (no CORS). Instead the page embeds the office's widget, served at the office's own origin, whose requests are then same-origin, and the widget relays events back by postMessage. Either include the loader:

```html
<script src="http://localhost:4870/embed/loader.js" data-default-team="TEAM_ID" async></script>
<script>
  addEventListener("office-comment:status", (e) => {
    const { id, status, openUrl, note, commit, meta } = e.detail;
    if (status === "fixed" && openUrl) location.assign(openUrl);
  });
</script>
```

It loads the widget hidden with the page, adds a **Comment** button (`data-label` changes its text) that opens it in a panel, and passes `location.href`, `document.title`, the hash, the current selection and the viewport size. `window.officeComment.open({openUrl, meta, selector, selectedText, title, anchor, viewport, url, screenshots})` opens it with more context; `close()` closes it; `watch(ids?)` narrows the relayed events to some comment ids (default: every comment from this page's origin). The loader re-dispatches every widget message on `window` as a `CustomEvent` named by its `type`, with the message as `detail`. Or frame it yourself:

```html
<iframe src="http://localhost:4870/embed/comment" title="Comment to a team" style="border:0;width:360px;height:420px"></iframe>
```

`GET /embed/comment` (also `/embed/comment.html`) serves the widget with `Content-Security-Policy: frame-ancestors 'self' <allowed origins>`, so only allowed pages can frame it. It shows a team picker (the last team for this page origin, else the page's `defaultTeamId`, else the first team with a lead), the page context, a comment box, image attachments (through `POST /api/uploads`) and the last comment's live status. Opened on its own (not framed), it also shows the allowed-origins editor.

**postMessage contract** (version 1; `EMBED_VERSION`):

| Direction | Message |
|---|---|
| widget → host | `{type: "office-comment:ready", version: 1}` once loaded, to any origin (it carries nothing) |
| host → widget | `{type: "office-comment:context", version: 1, page?, openUrl?, meta?, defaultTeamId?, screenshots?}`; send after `ready` and whenever the context changes, with the office's origin as `targetOrigin`. `openUrl` must be on the host's own origin (else dropped); `meta` as above; `screenshots` are up to eight `data:image/(png\|jpeg\|gif\|webp);base64,…` URLs, uploaded and attached |
| host → widget | `{type: "office-comment:watch", version: 1, ids?}`: relay status events for this origin's comments, or only these ids. The office filters by the host's origin, so ids cannot reach another page's comments. Without it, the widget still relays the comments it sent |
| widget → host | `{type: "office-comment:sent", version: 1, id, teamId, teamName, status}`; `{type: "office-comment:status", version: 1, id, teamId, status, openUrl, note, commit, meta, updatedAt}` on every change (and the current state when watching starts); `{type: "office-comment:error", version: 1, error}`; `{type: "office-comment:resize", version: 1, height}`. Posted only to the accepted host origin |

The widget accepts a host message only when `event.source` is its parent and `event.origin` is on the allowlist (`pageOriginAllowed`, `acceptEmbedMessage`): exact scheme and host, and the port exact or `*`. The first accepted origin stays the host for the widget's life. A `page.url` or `openUrl` on another origin than the sender's is dropped, so a page speaks only for itself. A refused origin sees a note in the widget saying so; nothing it sent is used.

**In the office**, the team panel lists the team's latest page comments under **Page comments**: page, comment, age, status (with who set it and the note) and the open link.

## Local CLI: write surface check

`inbox surface-check --writes "GLOB,GLOB" --base SHA [--commit SHA]` runs in a repository checkout and calls no service. It lists the files changed from `--base` to `--commit` (default `HEAD`; `git diff --name-status -M`) and prints each one no glob covers, exiting 1 when there are any and 0 otherwise. `--writes` takes comma-separated globs and may be repeated. `**` spans any number of folders (none included), `*` and `?` stay within one path part, and a trailing `/` covers a whole folder. A rename counts both its old path (deleted) and its new one; a deletion is a change like any other; a copy counts only the copy. Matching lives in `src/shared/surface.ts` (`test/surface.test.ts`). First mates give each crew task a `Writes: <globs>` line and run this before landing; it is a check on a diff, not a sandbox.

## Checks

`test/api-reference.test.ts` guards operation names/methods/paths against registry drift. Behavioral coverage: `test/http-contract.test.ts` (validation/methods/errors), `test/api-replay.test.ts` (keys/conflicts/atomic work), `test/typed-replies.test.ts` and `test/inbox.test.ts` (claim/recovery/revisions), `test/agent-client.test.ts` (typed client/errors), `test/undelivered-gone.test.ts` (queued deliveries to a gone agent fail with an error naming it, and the sender is told once), `test/pi-delivery.test.ts` (actual receipt boundary), `test/pagecomments.test.ts` (page comments, the origin allowlist and the unchanged Origin guard). These are isolated tests, not certification of every real harness/provider release.
