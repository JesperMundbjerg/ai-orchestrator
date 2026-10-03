# Pipeline delivery hooks

The office's deterministic pipeline gate owns authorization. Repo-local hooks are an explicitly installed **Git backstop**, not a replacement for the transactional handoff/review gates and not a security boundary against the checkout's owner.

## Install, inspect, remove

```sh
inbox pipeline install-hooks /path/to/repo-or-worktree --dry-run
inbox pipeline install-hooks /path/to/repo-or-worktree
inbox pipeline install-hooks /path/to/repo-or-worktree --uninstall
```

Installation creates:

- A command `PreToolUse` entry in `.claude/settings.json`, merging existing settings and hooks. Claude and Codex call the builtin-only `.claude/hooks/review-inbox-pipeline.mjs` entrypoint (commit it with the settings).
- A command `PreToolUse` entry in `.codex/hooks.json`, merging existing hooks. Codex **0.156.1** supports this project source and the `hookSpecificOutput.permissionDecision: "deny"` / `permissionDecisionReason` response.
- `.pi/extensions/review-inbox-pipeline.ts`, returning `{ block: true, reason }` asynchronously from `tool_call`. The v2 extension has minimal local types, no SDK dependency, and imports the runner only at runtime through a plain string variable; TypeScript never resolves the ignored runner or its `.ts` extension.
- A Git `pre-push` hook at Git's effective hooks path, including `core.hooksPath`. An existing hook is renamed to `pre-push.review-inbox-original-<checkout-hash>`; its executable mode, arguments, stdin and exit status are preserved. The gate runs first; a denied push never invokes the old hook.
- `.review-inbox-pipeline/`: a builtin-only runner, installed policy snapshot and ownership manifest. Keep these files available; removing them does not grant permission.

The committed entrypoints embed the installed protected-ref/command policy and the same read-only boundary parser. With a missing/invalid runner or config (including fresh clones/CI where local metadata is ignored), they load without it: protected operations are refused with **“pipeline guard runner missing at …; reinstall”**, while ordinary tools, feature pushes, editing, tests and local commits keep their existing behavior. No fallback contacts the office or authorizes delivery. The Git backstop uses the same standalone entrypoint and preserves feature-only pushes when metadata is absent. Re-install upgrades owned v1 marker files/manifests to `review-inbox-pipeline-guard-v2`, removes the old harness command entries, and preserves prior boundaries and the original Git-hook backup. Re-trust changed commands and reload Pi afterward.

No installation writes to `~/.claude`, `~/.pi` or `~/.codex`. Symlinked project configuration paths and malformed settings are refused before any writes. Re-install is idempotent; uninstall removes only our command entries, preserving hooks/settings added afterward. A pre-push hook edited after installation is left alone with a manual-resolution warning, never overwritten. Linked worktrees have local harness settings but normally share one Git hook: each explicit installation chains the previous backstop. Uninstall shared-hook installations in reverse order; removing an inner installation is refused until outer hooks are restored. A configured external/shared hooks directory is affected explicitly, so inspect the dry-run first.

**Install before pinning a run.** The dev gate refuses dirty/untracked candidate bytes. Commit the intended repo-local hook/config files or explicitly ignore local installation metadata under the repo's policy before starting the candidate wave; do not sweep unrelated edits into a commit merely to pass the gate.

**Activation matters.** Restart/reload Claude and Pi, and trust the project's extensions. Codex's stable `hooks` feature must remain enabled; review/trust the installed project command in Codex's hooks UI. Installation does **not** bypass or persist hook trust. Changed hook commands need a fresh trust review. Do not claim harness enforcement while the project hook is untrusted/disabled. Scratch tests use a session-only hook-trust bypass for a known generated command, not a production setting.

## Boundaries and configuration

The defaults protect `dev`, `main`, `master`, and the adapter's `integrationBranch`. Additional refs and literal delivery commands live in the main checkout's `orchestrator.json`:

```json
{
  "integrationBranch": "dev",
  "pipelineHooks": {
    "protectedRefs": ["release"],
    "guardedCommands": [
      {
        "command": "node .claude/hooks/worktree-sync.mjs land",
        "operation": "land",
        "ref": "dev",
        "candidateArgument": 1
      },
      {
        "command": "node .claude/hooks/worktree-sync.mjs publish",
        "operation": "publish",
        "ref": "dev"
      }
    ]
  }
}
```

`candidateArgument` is a zero-based index **after** the command prefix: for `land CHECKOUT SHA`, index 1 pins SHA. Without it, publishing pins the target branch tip and other commands pin `HEAD`. Prefixes are literal argv, not executable configuration or regexes. A script path also matches its absolute spelling by basename. The FysikLab adapter (`project: "fysiklab"`) or a configured `land` object adds guards for `.claude/hooks/worktree-sync.mjs land/publish`, both directly executable and through `node`. FysikLab's remaining checks are `npm run check:changed`, `npm run check`, and `npm run gates`; the hooks do not invoke checks or retired delivery tooling. Other delivery scripts require explicit `guardedCommands` entries. The installer snapshots this configuration; re-install adds protection but never silently removes an already-installed boundary when configuration disappears or changes. Intentional policy removal requires uninstall/re-install.

Hooks guard literal `git push`, `gh pr create`, Git protected-branch merges, and configured delivery commands. They recognize compound commands, literal `cd`, `git -C`, and branch switches. Protected Git merge preflight requires a single fast-forward candidate; squash, non-fast-forward and continued integration merges are refused locally. The v1 office gate also refuses direct merge/PR operations (no authorized release boundary), so protected integration uses the canonical pinned landing procedure. Unresolved PR merges and cross-repository PR operations require the explicit release procedure rather than guessing the candidate or target. Ordinary feature-branch merges, pushes, editing, tests and local commits remain available.

Before protected delivery, the first mate supplies `INBOX_PIPELINE_RUN` (and, where required by the gate, `INBOX_PIPELINE_ROUND`). The harness supplies session identity; manual shells must supply identity accepted by the CLI. Each boundary invokes:

```sh
inbox pipeline gate --repo CHECKOUT --operation push --ref refs/heads/dev --candidate SHA \
  --run RUN --round ROUND --harness pi --session /absolute/session.jsonl
```

Operations distinguish `push`, `pr`, `merge`, `land` and `publish`; the office must bind the run to the repository, target ref and delivery kind. A dev run cannot authorize a main-release PR/merge. Missing runs, crew rather than the current lead, stale candidates/rounds and incomplete evidence are the office's refusals. Exit 0 is allow; every nonzero exit is refusal. Hooks preserve exit-1 reasons and append an office-restart instruction (so an outage reported as exit 1 is still clear); other nonzero exits, timeout or a missing executable also fail closed. A shell environment variable is never a bypass or cached authorization.

The pre-push hook checks **every protected remote ref in Git's actual stdin**, using that update's included candidate SHA (not merely `HEAD`). Protected deletion is refused. If canonical landing produces a different commit SHA, the nested push is deliberately refused until the run's owned candidate checkout is pinned to that actual landed SHA and refreshed with `inbox pipeline branch RUN --candidate SHA --notes "…"`. Unchanged intended bytes preserve existing receipts; expanded/changed bytes require revalidation. Retry publication-pending with `worktree-sync publish`, never by re-landing the wave. There is no blanket mapped-SHA exception. Feature-only pushes do not contact the office. Tool hooks are read-only preflight; the Git hook rechecks at publication. An allow response is **not delivery evidence** and does not record landing/publication success: canonical delivery tooling must check before modifying the integration branch and record successful publication afterward. This installer does not rewrite repository delivery scripts.

## Re-base a wave after merging published integration work

```sh
inbox pipeline branch RUN --base SHA [--candidate SHA] --notes "Merged published dev; only our wave remains" --client-id rebase-wave-1
```

Only the team's **current first mate** may re-base an open run. The new base must already be reachable from a remote-tracking `dev` ref (or the adapter's `integrationBranch`) in the run repository, and must be an ancestor of the checked-out candidate. Fetch that branch and merge it into the team's checkout first. A local integration branch alone is not proof of publication; unpublished own work cannot be hidden as the base. The office does not fetch, merge or change Git refs. Omitted `--candidate` captures the checkout's current HEAD, including intended dirty/untracked bytes.

Changed paths and the intended-bytes fingerprint are recomputed against the new base **before** judging path guards. The fingerprint covers the wave's changed paths, final bytes/modes and deletions, not unrelated upstream bytes or commit metadata. Unchanged own bytes retain evidence and completions; changed/expanded scope starts a new round and leaves old evidence stale, exactly like a re-pin. Changed selections still clear completions. Legacy whole-tree snapshots stay readable; their first explicit re-base conservatively requires fresh evidence because their historical scoped bytes were not recorded separately.

Runs and the team briefing retain an append-only history with old/new base, reason, actor and time. Delivered or abandoned runs cannot be re-based. Keep `--client-id` before sending: exact retries return the original receipt after restart; changing caller/content conflicts. Base edits do not infer a revision from status, so retrying the same command/id is safe; an explicit `--revision` remains an optional optimistic lock. Re-base, history and replay receipt commit together, and an exact old receipt never authorizes delivery of a newer candidate.

## Planning evidence binds to the run, not changing implementation bytes

A graph step may set `"binding": "run"` for a planning report or scope/assignment artifact. In the editor, select the step and choose **Evidence binding → Run · planning for this round and scope**. Omitted binding remains `candidate`; names such as `plan`, human instructions, `builtin:work` and generic reports are not reliable planning types and are never guessed. Conditions already describe declared run selections and are intrinsically run concepts. For example:

```json
{ "id": "plan", "label": "First mate plans bounded wave", "kind": "step", "source": "builtin:work", "evidence": ["report"], "binding": "run" }
```

Run-bound reports may be recorded/endorsed while implementation bytes are changing, without a candidate re-pin. They are tied to the run id, current round and monotonic selection scope, so byte-only changes do not stale the plan. A new round (including a changed-bytes re-pin) or changed selections does: old planning evidence cannot be reused even if selections later toggle back. Metadata-only re-pins and unchanged-scope re-bases retain it. Assignments, evidence files, lead-only endorsement, dependencies and replay rules are unchanged.

Checks, review verdicts, founder approvals and delivery remain candidate-bound; the gate still requires a fresh final candidate and every activated candidate-bound step's current evidence. Run binding is not permission to publish unfinished implementation. Runs and briefings show each step's binding. Graph changes apply to new runs, not frozen existing snapshots; configure the planning step before starting the replacement wave.

## Closing an undeliverable run

The team's **current first mate** can close an open wave that will not be delivered:

```sh
inbox pipeline abandon RUN --notes "Superseded by the replacement wave" --client-id close-wave-1
```

Notes are required. Crew and other teams' leads are refused, as is a delivered run. Closure is terminal: the run becomes `abandoned`, cannot be edited or presented, and every delivery gate refuses it even if its evidence was complete. Start a new run for replacement work; abandonment never authorizes delivery or removes pipeline protection.

The graph, candidate, branch rationale, assignments, step dispositions and copied evidence remain available for the record. Runs shows abandoned entries muted with their reason below open runs; automatic team briefings and status select only open runs. Use `inbox pipeline status RUN` to inspect a closed run explicitly.

Retain `--client-id` before sending. An exact retry with the same caller, run, notes and id returns the original closure receipt, including after restart; changed content or caller is a replay conflict. Abandonment has no revision precondition, so retrying with just the same command/id does not pick up a changed ledger revision. A new id cannot re-close or reopen an abandoned run. The run transition, audit event and replay receipt commit atomically; no Git or delivery action is performed.

## Outages and limits

If the office/gate is unavailable, protected delivery fails closed with **“Restart the office and retry; editing, tests and local commits remain available.”** There is no cached green response, broad environment bypass, model call, or reasoning intermediary.

These are workflow guardrails. They do not stop an owner disabling hooks, `git push --no-verify`, shell aliases/indirection, unlisted delivery scripts, remote execution or another machine. **Codex app-server `command/exec` and `thread/shellCommand` are outside the model-tool `PreToolUse` dispatch**: do not claim those RPCs are blocked by the project command hook. Git's repo-local pre-push hook remains the backstop for their protected pushes, but an uninstrumented landing script can still mutate a local integration branch before pushing. Protect remote branches/required checks separately. The canonical landing path must be guarded and exercised before claiming the pilot is enforced.

## Scratch verification

`test/pipeline-hooks.test.ts` creates only temporary Git repos. It covers settings merge safety, idempotence, v1-to-v2 upgrades, dry-run, uninstall with concurrent additions, hooks-path chaining/restoration, linked worktrees, protected-ref candidates, merge safety, landing-script indirection, and fail-closed behavior while ordinary work continues. The generated Pi extension is checked with FysikLab's `.pi/tsconfig.json` settings (`noEmit`, no `allowImportingTsExtensions`) and no runner; all three harness entrypoints and Git are exercised with missing/broken runners and missing/malformed configs. These are deterministic scratch tests, not a live-harness certification.

**Real gate integration verified against office core `701651e`, 2026-10-02:** isolated temp HOME/data, a free loopback port (never 4870), no herdr, and all three machine-wide opt-ins set to 0. The installed runner called the real `inbox pipeline gate` through HTTP: an actual protected pre-push without a run was refused; completing the run's check enabled both the exact CLI preflight and the actual Git push to the scratch bare remote. Crew, missing evidence/run, stale SHA/bytes/round, another repository, main and release PR attempts were refused. Canonical land/publish tool-call preflights used the same gate. After stopping the scratch office, protected publication failed closed with restart guidance while a new feature-branch push still succeeded. The push left the run open: a gate allow is not a delivery receipt. No FysikLab checkout was modified or executed.

Manual verification (not part of `npm test` or CI):

```sh
node --test test/pipeline-hooks-codex.manual.ts
```

**Verified on installed Codex 0.156.1, 2026-10-02:** its real hook dispatcher consumed a loopback-only canned SSE transcript; the protected `exec_command` returned our unavailable-gate denial as its tool output and did not create even its semicolon-separated marker. No inference or external model service ran. The script uses temporary HOME/CODEX_HOME, an environment whitelist without API tokens/auth-file overrides, and session-only trust for the known scratch hook. It requires that version rather than silently asserting another version's behavior. No verification installs into FysikLab or the running office's checkout.
