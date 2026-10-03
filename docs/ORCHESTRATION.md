# Project adapter: `orchestrator.json`

This is the **implemented adapter format**, not a migration plan. The adapter describes a repository to Review Inbox; it does not install a scheduler, comment store, check runner or landing service. See [API.md](API.md) for HTTP and [ARCHITECTURE.md](ARCHITECTURE.md) for identifier meanings.

## Location and loading

Put strict JSON (no comments or trailing commas) in `orchestrator.json` at the repository's **main checkout root**. Linked worktrees share that description. `src/server/adapter.ts` checks the file's modification time and size on reads and reparses changed files.

- Missing/unreadable-by-stat file: no adapter, no problems.
- Invalid JSON or known-field validation errors: the entire adapter is withheld; `Repository.adapter` is `null` and `adapterProblems` lists the problems.
- Unknown **top-level** keys: reported and ignored, without rejecting an otherwise valid adapter. Unknown nested keys are ignored without that warning.
- No environment interpolation, `envFile` loading, shell execution or project code import occurs. The one command the service runs is a lane's `attach` argv (below), never through a shell.

A fictional example:

```json
{
  "project": "garden-notes",
  "integrationBranch": "main",
  "preview": { "base": "http://localhost:3000" },
  "comments": {
    "kinds": ["bug", "idea"],
    "anchor": ["page", "section"],
    "charter": "docs/review-charter.md",
    "leaseMinutes": 45
  },
  "decisions": { "maxQuestion": 400 },
  "checks": { "changed": "npm test", "full": "npm run typecheck && npm test" },
  "reviewers": { "perSlice": ["code-reviewer"], "cap": "once per slice" },
  "land": { "mode": "ff-only", "publish": "git push origin main" },
  "lanes": [
    { "name": "builder", "worktree": "../garden-notes-builder", "harness": "pi" },
    { "name": "reviewer", "agent": "review-session", "role": "review" }
  ]
}
```

## Fields and actual effects

Optional scalar fields generally accept omission or `null`; provided strings must be non-empty and are trimmed. Optional lists below default to `[]`; optional objects default to `null`. The normalized response includes nulls: do not assume absent values are omitted.

| Field | Accepted value | Implemented use |
|---|---|---|
| `project` | Lowercase slug (letters, digits, dashes), default derived from repository name | Namespace for `GET /api/p/:project/queue`; not a repository UUID or team id |
| `integrationBranch` | String | Descriptive metadata only; no landing operation |
| `preview.base` | String starting with an http(s) address | Descriptive metadata; no port substitution or preview server startup |
| `comments.kinds`, `comments.anchor` | Lists of non-empty strings | Metadata only; no comments API or anchor filtering |
| `comments.charter` | String | Metadata only; no file read or charter enforcement |
| `comments.leaseMinutes` | Positive integer | Metadata only; no lease runner |
| `decisions.maxQuestion` | Positive integer | Metadata only; does not impose an inbox question limit |
| `checks` | Object mapping arbitrary names to non-empty command strings | Metadata only; commands never run |
| `reviewers.perSlice`, `reviewers.cap` | String list; string | Metadata only; does not start or enforce reviewers |
| `land.mode`, `land.publish`, `land.setup` | Strings | Metadata only; commands never run |
| `lanes` | List of lane objects, default `[]` | Joins declared lanes to observed office agents and supports lane-name messaging; a lane's `attach` argv is run for status and explicit recovery (below) |

An empty `preview` object yields `null`. A lane requires `name`, unique case-insensitively. Its optional `worktree`, `agent`, `model`, `role` and `harness` are non-empty strings; `harness` must be `pi`, `claude`, `codex` or `manual`. Relative worktree paths resolve against the main checkout root; absolute paths stay absolute. These paths are descriptions, not requests to create or claim worktrees. `harness` and `model` supply offline display fallbacks, not launch instructions or match filters. Optional `attach` is a non-empty list of non-empty strings (argv, not a shell line).

## A standing lane's attach command

A lane may name its project's own command for its standing session as argv:

```json
{ "name": "dispatcher", "worktree": ".", "attach": ["node", "scripts/attach-lane.mjs", "dispatcher"] }
```

The service runs it with the lane's worktree (or the main checkout) as the working directory, `node` as the node running the service, and one of two suffixes:

| Mode | Appended | When | The command must not |
|---|---|---|---|
| status | `--status --json` | when the lane is read, at most every 30 s (timeout 20 s) | write, rename, signal or unclaim anything |
| recover | `--recover --pane PANE --session SESSION --json` | only on the founder's explicit Recover (timeout 120 s) | rename the agent or its pane, signal a process it has not verified as its own companion, or take work from a session still executing it |

Its **last stdout line** is one JSON object: `state`, `reason`, `registered: {session, pane} | null`, `companion: {pid, fresh, log} | null`, `progressAt` (the registered session's last completed turn, or null; shown as such, never as proof of work) and `changed` (recover: whether anything was written or started). The exit code must match `state`: `0` connected, `3` disconnected (the registered session is confirmed gone), `4` busy (the old session is working or blocked, or another recovery holds the lane), `5` unavailable (a transport error; nothing changed), `6` refused (wrong session, harness, checkout or lane, ambiguity, or a live owner it cannot verify; nothing changed), `7` failed (the companion did not become ready; the registration is left recoverable). Anything else, or JSON that disagrees with its exit code, is a transport error. Retrying a recovery that already succeeded must return `0` with `changed: false` and start nothing. With `attach`, the lane joins the office agent running the registered session, not `agent`; see [DESIGN](DESIGN.md) for what the office shows.

## Lane matching

`src/server/queue.ts` matches lanes as follows:

1. With `worktree`, require the agent's resolved working directory to equal that path (not a recursive directory match).
2. With `agent`, additionally require an exact herdr agent name or reported Pi session name. It never substitutes another agent merely sharing the folder.
3. With only `worktree`, any agent there can match. With neither field, match the lane name against the herdr name exactly or the office display name case-insensitively.
4. Prefer a running match over an offline desk, then a working match, with display name as the tie-breaker.

Pi's session **name** is its `/name`/terminal-title label, reported per session in memory; it is not the absolute session-file **id** used to address replies. Office display names are another separate namespace.

`inbox say <lane> ...` resolves office names and teams first, then adapter lanes. If several repositories declare that lane name, the sender's repository selects it; ambiguity is refused.

## Queue response

`GET /api/p/garden-notes/queue` returns:

```json
{
  "project": "garden-notes",
  "lanes": [{
    "name": "builder", "role": null, "agentId": null, "agentName": null,
    "harness": "pi", "model": null, "state": "offline", "doing": null,
    "branch": null, "carrying": [], "why": "nobody runs in /work/garden-notes-builder"
  }],
  "counts": { "waiting": 0, "assigned": 0, "working": 0, "held": 0, "fixed": 0 },
  "held": [],
  "paused": false
}
```

The path in `why` reflects the resolved example checkout. Lane states are `working`, `blocked`, `idle` or `offline`; unknown/done presence maps to `idle`. **Only the lane observations are populated.** Counts are zero, `held` and `carrying` are empty, and `paused` is false. There is no queue mutation, comment/fix intake, assignment, lease, cursor or landing API. An unknown project key returns 404; a broken adapter recognized by repository name returns 422 with its problems.

Tests: `test/adapter.test.ts`, `test/queue.test.ts`.
