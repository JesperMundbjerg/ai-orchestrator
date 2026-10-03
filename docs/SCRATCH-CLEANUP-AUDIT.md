# Scratch cleanup audit

Incident follow-up: a verification shell's pattern-wide cleanup stopped the unrelated live office. Repository search (including hidden files, excluding `.git`, dependencies and built output) found **no checked-in `pkill`, `killall`, `pgrep -f` or `kill -9` call site**. The offending ad-hoc shell command is not a repository launcher; no claim is made that it was located or removed here.

Per the narrowed incident scope, existing PID/handle-based launchers are not broadly migrated. The custom scratch verification recipe in CONTRIBUTING now runs `scripts/lib/scratch-office.ts`: it owns one detached child group, records PID/start time/command/launch token and supplied command/port, and rechecks identity before TERM and before timeout escalation to KILL. Missing/reused/uninspectable identity never triggers a signal. Its guard refuses port 4870, the real HOME/data directory (including symlink aliases), enabled integrations and live herdr paths. It never invokes the live restarter.

## Service launcher/cleanup inventory

| Location | Ownership and cleanup today |
| --- | --- |
| `scripts/lib/scratch-office.ts` | New documented custom verification launcher; only its recorded, reverified child process group. |
| `scripts/demo.ts` (`startDemo`, `stopChild`) | Spawned office ChildProcess; TERM then timed KILL on that handle. Static preview and port reservation are in-process server objects, closed directly. |
| `scripts/dev.ts` | Starts Node watch + Vite; sends TERM to its two ChildProcess handles. Not an isolated scratch-office launcher. |
| `scripts/restart-office.ts` | Legitimate live-office operations script, not a test helper: listener PID from lsof, Node/main.ts command check, TERM then KILL on that PID; starts detached replacement. **Unchanged by this scoped fix; not upgraded to a persisted start-time identity record.** |
| `scripts/check-games.mjs`, `scripts/check-garden-ui.mjs`, `scripts/check-jars.mjs`, `scripts/check-meeting.mjs` | In-process office HTTP server plus free-port probe; close exact server objects and DB; close Playwright browser in finally. No process-name cleanup. |
| `test/advance.browser.mjs`, `test/decision-sheet.browser.mjs`, `test/leadwatch.browser.mjs`, `test/watchdog.browser.mjs` | Spawn office/fixture; TERM exact ChildProcess, wait for exit; close browser. |
| `test/back-of-queue.browser.mjs`, `test/lanes.browser.mjs` | Spawn office; kill exact ChildProcess; close browser. |
| `test/autoapprove.browser.mjs` | Start/stop/restart exact office ChildProcess (TERM + exit wait); close browser. |
| `test/pipeline-ui.browser.mjs`, `test/wilds.browser.mjs`, `test/wilds-fix.browser.mjs` | Spawn office; TERM exact ChildProcess + exit wait; close browser. |
| `test/meters.browser.mjs`, `test/review-fallback.browser.mjs` | In-process office HTTP server and port probe; close server/DB/browser objects in finally. |
| `test/demo.test.ts` | Calls `startDemo`; owns the returned `close` function. |
| `test/all-leads.test.ts`, `test/autoapprove.test.ts`, `test/crewtree.test.ts`, `test/http.test.ts`, `test/pipeline-approval.test.ts`, `test/pipeline-hooks.test.ts`, `test/pipelines.test.ts`, `test/queue.test.ts`, `test/standing-lanes.test.ts`, `test/story.test.ts`, `test/uploads.test.ts`, `test/usage.test.ts`, `test/video.test.ts` | In-process test HTTP services, sometimes with separate free-port probes; close exact server objects. Pipeline/story/video CLI children are commands, not office services. |
| `test/page-check.test.ts` | In-process office and fake preview HTTP server; close both objects. |
| `test/herdr.test.ts` | Fake Unix-socket herdr server; destroys its own sockets and closes its server object. |
| `test/http-contract.test.ts` | Office HTTP callback fixture without listen; closes exact server object. |
| `test/world.test.ts` | Spawns a `sleep` fixture to exercise worktree finishing; production worktree cleanup below stops it. |
| `test/pipeline-hooks-codex.manual.ts` | Opt-in real Codex fixture, not an office service; KILL exact ChildProcess in test after-hook. |
| `test/scratch-office.test.ts` | Two real isolated office children via new helper; cleanup of one leaves other answering; mismatch refusal, guards and TERM/KILL re-verification regression. |

`test/fixtures/leadwatch-office.ts` and `test/fixtures/watchdog-office.ts` host fixture services; their browser callers above own child cleanup. No shared `test/helpers` service launcher existed at audit time. Database-only test fixtures do not launch a service/process.

## Other process signal sites (not scratch cleanup)

- `src/server/machine.ts`: optional browser controller, injected/default `process.kill`, direct TERM/KILL to listed browser root PIDs, with existing identity checks/tests. Not touched.
- `src/server/worktrees.ts`: worktree process discovery, `process.kill(pid, 0)` liveness check, TERM/KILL for worktree finishing. Not touched.
- ChildProcess `.kill` and restarter `process.kill` sites are enumerated above. No checked-in shell pattern-kill site was found.

## Verification

Node v24.21.0 / macOS; no browsers or live-office operations run. All tests/checks ran with `GIT_INDEX_FILE` unset.

- `node --test test/scratch-office.test.ts`: 3/3 pass, including two actual services on distinct free ports with isolated HOME/data/herdr/integrations.
- `npm run typecheck`: pass.
- `npm test`: 659/661 pass. Concurrent pipeline failures: `pipeline-history.test.ts:151` expects schema 10 while current migration produces 11; `pipeline-hooks.test.ts:422` generated extension rejects `lanes` in `Config`. No pipeline/waiver files modified for this fix.
- `npm run build`: pass.

macOS identity inspection uses `ps` start time plus a random per-launch environment token; Linux uses `/proc` start ticks plus that token. Linux execution was not checked in this session. This is an owned verification launcher, not a host watchdog. Existing demo/browser/live-restarter identity improvements remain outside the founder's narrowed scope.
