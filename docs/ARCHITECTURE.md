# Architecture: the implemented office

Review Inbox is a local service, an HTTP client/CLI, harness integrations and two views of the same state (inbox/board and 3D office). There is no model-calling coordinator. This map describes the **current implementation**, not the extraction targets suggested by earlier reviews. Correctness rules live in [DESIGN.md](DESIGN.md); wire contracts in [API.md](API.md); repository metadata in [ORCHESTRATION.md](ORCHESTRATION.md).

```text
React UI ───────────────┐
inbox CLI / hooks ──────┼─ HTTP + global SSE ── createInboxServer
Pi extension ──────────┘                        │
                                        Inbox / World / controls
                                                │
                         SQLite / local files / git / optional herdr
```

## Module map and side-effect boundaries

| Location | Actual ownership |
|---|---|
| `src/server/main.ts` | Composition: data directory, SQLite, Inbox, World, crew tree, Usage, Switches, optional Machine, timers and HTTP listener |
| `src/server/startup-config.ts` | Independent opt-ins for authenticated Codex polling, continuous presence discovery and machine/browser cleanup |
| `src/server/http.ts` | Routing, unknown-input decoding, Host/Origin/media guards, errors, SSE, evidence/static serving **and callback/reaction wiring**. Construction sets the services' single `onChange` callbacks and dispatches `world.react()` on relevant changes |
| `src/shared/agent-protocol.ts`, `src/server/request-validation.ts` | Executable agent request/response schemas and UI/control ingress schemas; syntax checks here, state/revision rules in services |
| `src/server/db.ts` | Complete SQLite schema, transactional versioned migrations (`PRAGMA user_version`), unversioned/partial legacy adoption and newer-schema refusal; not interrupted-operation recovery |
| `src/server/inbox.ts` | Session/repository/task binding, submission normalization and revision/evidence identity, answers, durable reply ownership, recovery and inbox projection. Owns use-case transactions and constructs Uploads |
| `src/server/uploads.ts`, `evidence.ts`, `review-excerpt.ts` | Image staging/lookup; evidence HTTP range streaming; fail-closed source excerpt reading. Uploads imports InboxError from Inbox: this is not yet a fully acyclic storage/domain boundary |
| `src/server/world.ts` | Durable agent identity/placement, lead rules, repository discovery, team/project/worktree lifecycle, briefs/harness settings, report/control dispatch, office projection and reactions. Constructs Messages, Activity, Efforts and ReviewFallback |
| `src/server/worktrees.ts`, `src/shared/project.ts` | Git/checkout facts and local process/worktree helpers. `shared/project.ts` is Node-only despite its shared location |
| `src/server/adapter.ts`, `queue.ts` | Read-only adapter metadata and lane-to-agent joins; no comment store, scheduler or landing runner |
| `src/server/messages.ts` | Fixed recipient policy, message/review-work transactions, replay fingerprints/results, guarded pane delivery/batching and interrupted-send recovery |
| `src/server/notices.ts`, `loops.ts`, `undelivered.ts`, `unpresented.ts`, `waiting.ts`, `stale.ts`, `agent-starting.ts` | Advisory notices and durable episode/cooldown latches; current idle/stale/startup observations and bounded retries. These use the normal delivery path, not a second bus |
| `src/server/switch.ts` | Durable workflow/checkpoints around non-idempotent effects, replacement-pane visibility/held deliveries, identity takeover and recovery-required pauses |
| `src/server/activity.ts`, `effort.ts`, `models.ts` | Ephemeral tools/helpers/model/session-name observations, in-memory session-only effort control, local transcript model fallback |
| `src/server/review-fallback.ts` | Asynchronously cached git candidate lists and safe projector selection; display-only changes, no invented agent activity or model call |
| `src/server/autoapprove.ts`, `qa.ts`; `src/shared/qa.ts` | The founder's inbox automation setting (Off, Approve all, QA answers); the QA agent's queue, answers, learning feed and cursor. No model call; the QA agent is an ordinary office session |
| `src/server/crewtree.ts`, `crewtree.default.json`; `src/shared/crewtree.ts` | Authoritative crew-choice JSON, seed, validation and selection rules |
| `src/server/usage.ts`, `codexaccount.ts`; `src/shared/usage.ts` | Local transcript/cache parsing, token attribution, persisted latest meter readings/pause notices, optional authenticated account read; no model inference |
| `src/server/herdr.ts`, `machine.ts` | Concrete terminal presence/prompt/focus/pane/worktree adapter; optional local process watcher and verified headless-main-process signalling |
| `src/shared/types.ts`, pure shared rule modules | Public/domain DTOs and cross-client decisions, panes, page/story/review/slug/waiting rules. The shared directory is **not uniformly browser-safe** |
| `src/shared/agent-client.ts` | Node/environment-aware injectable typed HTTP client, structured transport errors, cancellation; no automatic mutating retries |
| `src/cli/`, `bin/inbox` | Agent commands, hook/statusline plumbing and direct herdr pane creation (`pane.ts`); provider command handling is not entirely centralized in the server |
| `integrations/pi/` | Session registration, reports, actual receipt-correlated reply delivery/acknowledgement and effort control |
| `src/ui/api.ts`, components | HTTP transport and inbox/board interactions. Capability-based controls; no direct harness/provider calls |
| `src/ui/world/` | Lazy-loaded spatial rendering/animation, pure layout/activity rules and panels. `Talk.tsx` also holds message rows/forms/selectors shared with TeamBoard; not all renderer-neutral behavior has been extracted |

**Reads are not all pure.** `World.state()` reconciles observations into durable identity/placement/lead records, discovers repositories and can prune missing worktree records. Its callers include `/api/world`, lane queue reads, briefs, resolution and usage attribution. `Usage.meters()` can read local limit caches and persist newer observations. Model fallback can read session files during projection. Projector git enumeration is now asynchronous/cached, but bounded safe source-file reads still occur to produce a slide. Do not assume adding a GET/view observer is side-effect-free.

The service classes mix rules, SQL and effects; `createInboxServer()` currently owns application notification/dispatch wiring, and change callbacks are single slots, not a multi-subscriber event bus. A future pure snapshot/application-composition extraction should preserve existing transactional and delivery semantics rather than documenting that separation as already present.

## Glossary

| Term | Meaning / wire names |
|---|---|
| **Repository** | Git common-directory identity groups all checkouts; inbox `Project`/`projects` and `Task.projectId` represent this grouping. `WorldAgent.project` is a display name; world `Repository` describes the main checkout |
| **Project team / worktree project** | A `Team` with `standing=false`, its own checkout (`path`, `branch`) and lead. It is not an inbox repository id |
| **Standing team** | A `Team` without an owned primary checkout; members may work anywhere, and it can own additional worktrees |
| **Project key** | Adapter `project` slug in `/api/p/:project`; not either UUID/id above |
| **Session task** | `Task`, addressed by `(harness, sessionId)`; memory/review context, not a schedulable unit |
| **Office agent** | Durable `world_agents` record derived from harness/checkout/provider name, preserved across identity takeover. Its id anchors messages, story and placement |
| **Office name** | Unique human-readable display name from the pool or a rename; not the herdr agent name or Pi session `/name` label |
| **Review item** | Versioned Decide/Try/Milestone request owned by a session task; founder answers it |
| **Review work** | `Work` handed between teams, with reviewing team, verdict and rounds; agents review it, not the founder inbox |
| **Reply delivery** | A founder answer to an item, with deliveryId and exact harness/session owner |
| **Message delivery** | One fixed office-agent recipient row for a message; guarded pane prompt, not agent reply polling |
| **Lane** | Either an additional team-owned worktree, or a declared adapter lane joined to an agent. Neither is a reply queue or a comment lease |
| **World** | Office projection plus its current service implementation; not a separate database or autonomous orchestrator |
| **Founder** | The local user role; reserved message target `founder`, not a personal identity |

## State lifetime and restart recovery

Commands/receipts need different treatment from observations/caches. The table records current behavior, including limitations.

| State | Authority/lifetime | Restart/recovery |
|---|---|---|
| Repositories, session tasks, items/revisions, replies, history/evidence metadata | Durable SQLite | Reopen preserves ids/revisions and stale checks; files are separate evidence assets |
| Agent identity, office names/stories, placements, teams/worktree ownership, pane-team records | Durable SQLite | Reconciled against new observations; missing checkouts can release records, but never pipeline runs, which are archived with their team. Pane-team association expires after consumption or one day |
| Messages, fixed recipients, work rounds/verdicts and replay receipts/results | Durable SQLite; atomic use-case commits | Recipients do not change on retry. Work mutation and actionable message roll back together; exact replay returns original work-round result |
| Reply claim transport/owner | Durable before dispatch | Interrupted pane/legacy claims become failed/may-have-arrived, never automatically handed to an integration. Integration claims remain re-pollable with deliveryId deduplication |
| Message `sending` claim | Durable conditional claim | Marked failed/may-have-arrived at Messages construction; explicit Retry can duplicate receipt. Definite pre-submission inactive-agent refusal alone gets bounded startup requeue |
| Switch step, effect intent, pane identities, handoff path and brief state | Durable SQLite plus handoff file | Resume reconciles identifiable effects. Unknown opening/launch/brief outcomes pause visibly rather than replay; ordinary deliveries remain held until confirmed brief |
| Approve-all setting/count and auto-answer history | Durable SQLite | Off by default; restart keeps chosen rule and uses ordinary revision/answer/replay path, never automatically retries failed/uncertain delivery |
| QA answers: chosen QA agent, learning cursor, who answered (`replies.answered_by`) | Durable SQLite; learnings are the QA agent's own files in `learnings/` | Restart answers nothing; what the QA agent has is derived when read (online agent, eligible item), so an offline agent returns everything to the founder without a timer |
| Pending effort requests/results | **In-memory only, current limitation** | Disappear at restart along with reports. A running-process 30-second timeout is visible; restart does not preserve that promise |
| Crew tree | Authoritative `crew-tree.json` outside SQLite | Seeded once from default; saved JSON persists mode, rules and harness/model pairs |
| Activity, helpers, reported model/session name/capability/current effort | In-memory session-scoped observations | Re-report after restart/session replacement; tool line fades after 2 minutes, helpers after 30; idle clears turn activity |
| Usage limit readings and pause-notice latch | Durable SQLite | Latest readings retain age/reset semantics; optional sources refresh them |
| Transcript scan offsets/dedupe/hour buckets/token attribution | Rebuildable in-memory cache of local files | Rescan/catch up after restart; not a durable billing ledger. Partial local observations do not establish zero account use |
| Presence, sampled screen/stale-working evidence, team-blocked announcements | In memory | Observe afresh; never infer idle/working from old persisted timestamps alone |
| Reminder/watchdog/ack-loop cooldowns and notice latches | Durable SQLite | Latches and associated notices commit together; no repeat just because service restarted. Continuous-idle observation starts afresh |
| Headless process identity, idle/hot observations, since-start closed count | In memory; only if enabled | Restart begins a new observation interval/count; signalling rechecks actual process identity |
| Projector candidate lists/slide slot, adapter/git fact caches | Rebuildable caches | Cold projector shows idle until asynchronous list ready; safe source bytes are rechecked, not cached as trusted |
| UI camera/preferences/animations/wildlife | Page-local (some preferences localStorage) | No service correctness state; no persistent wildlife history |

Back up **the whole data directory**, not just `inbox.sqlite`: include SQLite consistently (stop the service or use a SQLite-aware backup, including WAL when needed), `files/`, `uploads/`, `crew-tree.json`, `handoffs/` and `learnings/` (the QA agent's). Default data directory is `~/.review-inbox`, overridden by `INBOX_DATA_DIR`; checkout/harness transcripts live elsewhere and are not copied by that backup. Schema migrations are storage-owned transactions; a newer database version is refused before modification. Never downgrade a backup by blindly opening it with an older checkout.

## Optional provider and integration matrix

herdr is the only concrete terminal provider shipped. Narrow behavior interfaces (`PresenceSource`, `AgentSource`, `SwitchSource`) exist, but provider replacement is not yet plug-and-play: wire presence fields still name herdr, World renders some herdr instructions and the CLI opens panes directly. UI behavior is capability-based, not vendor-command-based.

| Feature | Without herdr/discovery | With configured herdr |
|---|---|---|
| Submit/revise, evidence, founder answers, inbox/board | Works with explicit session identity | Same |
| Live integration / boundary hook / manual pull replies | Works, exact-session polling/ack | Same, preferred over terminal fallback |
| Tool/helper/model/session-name reports, session-only effort | Works when integration reports capabilities | Same |
| Office identities from submitted tasks, names/stories/team records | Available, with unknown/offline presence | Adds agents that never submitted and observed status |
| Presence, Open conversation, stale-screen observation | Unknown/unavailable | Needs continuous discovery opt-in and usable socket/CLI |
| Office messages / handoffs / review messages | Stored; terminal deliveries wait | Guarded prompt to idle/done recipient with uptake confirmation |
| Idle-session fallback founder replies | Wait for integration/hook/pull | May be durably claimed and prompted, with uptake confirmation |
| Pane creation, project start/finish, harness switch | Cannot perform terminal/workspace effects | Explicit actions require herdr and installed/logged-in target harness; safety refusals still apply |
| Adapter lane read | Works from known agents; offline lanes still listed | Can join provider-observed agents |
| Usage from reports/local files | Available independently | Same |
| Authenticated Codex account meter | Off unless separately enabled | Still independent of herdr |
| Machine/headless-browser control | Absent unless separately enabled | Still independent of herdr |

The three startup settings default to **off**: `INBOX_PRESENCE_DISCOVERY`, `INBOX_CODEX_ACCOUNT_POLLING`, `INBOX_BROWSER_CLEANUP`. Each accepts `1/true` or `0/false` (case-insensitive); invalid values fail startup. The founder's restart script explicitly sets them on for the established office. These control background integrations, not a security sandbox: explicit pane/project/switch actions can still invoke herdr, and switch resume may refresh it. Core startup still scans local harness usage/session files and seeds the crew tree; disabling account polling does not disable those local observations. Machine-disabled startup constructs no watcher or process-control HTTP surface.

## Behavioral checks

- Revisions, stale answers and evidence: `test/inbox.test.ts`, `pages.test.ts`, `video.test.ts`.
- Validation/method/error/replay contract: `test/http-contract.test.ts`, `api-replay.test.ts`, `api-reference.test.ts`, `agent-client.test.ts`.
- Durable schema and interrupted claims: `test/db.test.ts`, `typed-replies.test.ts`, `interrupted-delivery.test.ts`.
- Switch intent/result gaps and held brief: `test/switch-boundaries.test.ts`, `switch.test.ts`.
- Recipient/placement/lead/lane rules: `test/world.test.ts`, `pane-team.test.ts`, `queue.test.ts`, `all-leads.test.ts`.
- Advisory latches and machine controls: `test/loops.test.ts`, `undelivered.test.ts`, `unpresented.test.ts`, `machine.test.ts`, `startup-privacy.test.ts`.
- Observation/controls/display safety: `test/effort.test.ts`, `usage.test.ts`, `story.test.ts`, `names.test.ts`, `review-fallback.test.ts`, `pi-delivery.test.ts`.

Run `npm run typecheck`, `npm test`, `npm run build` for the source-checkout baseline. Standalone browser scripts are separate checks, not included in `npm test`; use free ports, temporary HOME/data, and disabled herdr/account/process integrations. Mocked and browser tests are not evidence that arbitrary versions of real harnesses or herdr support the required operations.
