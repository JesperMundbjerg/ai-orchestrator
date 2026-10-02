# Pipeline delivery hooks

The office's deterministic pipeline gate owns authorization. Repo-local hooks are an explicitly installed **Git backstop**, not a replacement for the transactional handoff/review gates and not a security boundary against the checkout's owner.

## Install, inspect, remove

```sh
inbox pipeline install-hooks /path/to/repo-or-worktree --dry-run
inbox pipeline install-hooks /path/to/repo-or-worktree
inbox pipeline install-hooks /path/to/repo-or-worktree --uninstall
```

Installation creates:

- A command `PreToolUse` entry in `.claude/settings.json`, merging existing settings and hooks.
- A command `PreToolUse` entry in `.codex/hooks.json`, merging existing hooks. Codex **0.156.1** supports this project source and the `hookSpecificOutput.permissionDecision: "deny"` / `permissionDecisionReason` response.
- `.pi/extensions/review-inbox-pipeline.ts`, returning `{ block: true, reason }` from `tool_call`.
- A Git `pre-push` hook at Git's effective hooks path, including `core.hooksPath`. An existing hook is renamed to `pre-push.review-inbox-original-<checkout-hash>`; its executable mode, arguments, stdin and exit status are preserved. The gate runs first; a denied push never invokes the old hook.
- `.review-inbox-pipeline/`: a builtin-only runner, installed policy snapshot and ownership manifest. Keep these files available; removing them does not grant permission.

No installation writes to `~/.claude`, `~/.pi` or `~/.codex`. Symlinked project configuration paths and malformed settings are refused before any writes. Re-install is idempotent; uninstall removes only our command entries, preserving hooks/settings added afterward. A pre-push hook edited after installation is left alone with a manual-resolution warning, never overwritten. Linked worktrees have local harness settings but normally share one Git hook: each explicit installation chains the previous backstop. Uninstall shared-hook installations in reverse order; removing an inner installation is refused until outer hooks are restored. A configured external/shared hooks directory is affected explicitly, so inspect the dry-run first.

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
        "command": "node scripts/worktree-sync.mjs land",
        "operation": "land",
        "ref": "dev",
        "candidateArgument": 1
      },
      {
        "command": "node scripts/worktree-sync.mjs publish",
        "operation": "publish",
        "ref": "dev"
      }
    ]
  }
}
```

`candidateArgument` is a zero-based index **after** the command prefix: for `land CHECKOUT SHA`, index 1 pins SHA. Without it, publishing pins the target branch tip and other commands pin `HEAD`. Prefixes are literal argv, not executable configuration or regexes. A script path also matches its absolute spelling by basename. The FysikLab adapter (`project: "fysiklab"`) or a configured `land` object adds guards for `worktree-sync.mjs land/publish`, both directly executable and through `node`. Other delivery scripts require explicit `guardedCommands` entries. The installer snapshots this configuration; re-install adds protection but never silently removes an already-installed boundary when configuration disappears or changes. Intentional policy removal requires uninstall/re-install.

Hooks guard literal `git push`, `gh pr create`, Git protected-branch merges, and configured delivery commands. They recognize compound commands, literal `cd`, `git -C`, and branch switches. Protected Git merges require a single fast-forward candidate; squash, non-fast-forward and continued integration merges are refused in favor of the canonical pinned landing procedure. Unresolved PR merges and cross-repository PR operations require the explicit release procedure rather than guessing the candidate or target. Ordinary feature-branch merges, pushes, editing, tests and local commits remain available.

Before protected delivery, the first mate supplies `INBOX_PIPELINE_RUN` (and, where required by the gate, `INBOX_PIPELINE_ROUND`). The harness supplies session identity; manual shells must supply identity accepted by the CLI. Each boundary invokes:

```sh
inbox pipeline gate --repo CHECKOUT --operation push --ref refs/heads/dev --candidate SHA \
  --run RUN --round ROUND --harness pi --session /absolute/session.jsonl
```

Operations distinguish `push`, `pr`, `merge`, `land` and `publish`; the office must bind the run to the repository, target ref and delivery kind. A dev run cannot authorize a main-release PR/merge. Missing runs, crew rather than the current lead, stale candidates/rounds and incomplete evidence are the office's refusals. Exit 0 is allow; exit 1 is policy refusal; other nonzero exits, timeout or a missing executable are fail-closed failures. A shell environment variable is never a bypass or cached authorization.

The pre-push hook checks **every protected remote ref in Git's actual stdin**, using that update's included candidate SHA (not merely `HEAD`). Protected deletion is refused. Feature-only pushes do not contact the office. Tool hooks are read-only preflight; the Git hook rechecks at publication. An allow response is **not delivery evidence** and does not record landing/publication success: canonical delivery tooling must check before modifying the integration branch and record successful publication afterward. This installer does not rewrite repository delivery scripts.

## Outages and limits

If the office/gate is unavailable, protected delivery fails closed with **“Restart the office and retry; editing, tests and local commits remain available.”** There is no cached green response, broad environment bypass, model call, or reasoning intermediary.

These are workflow guardrails. They do not stop an owner disabling hooks, `git push --no-verify`, shell aliases/indirection, unlisted delivery scripts, remote execution or another machine. **Codex app-server `command/exec` and `thread/shellCommand` are outside the model-tool `PreToolUse` dispatch**: do not claim those RPCs are blocked by the project command hook. Git's repo-local pre-push hook remains the backstop for their protected pushes, but an uninstrumented landing script can still mutate a local integration branch before pushing. Protect remote branches/required checks separately. The canonical landing path must be guarded and exercised before claiming the pilot is enforced.

## Scratch verification

`test/pipeline-hooks.test.ts` creates only temporary Git repos. It covers settings merge safety, idempotence, dry-run, uninstall with concurrent additions, hooks-path chaining/restoration, linked worktrees, protected-ref candidates, merge safety, landing-script indirection, and fail-closed behavior while ordinary work continues.

Manual verification (not part of `npm test` or CI):

```sh
node --test test/pipeline-hooks-codex.manual.ts
```

**Verified on installed Codex 0.156.1, 2026-10-02:** its real hook dispatcher consumed a loopback-only canned SSE transcript; the protected `exec_command` returned our unavailable-gate denial as its tool output and did not create even its semicolon-separated marker. No inference or external model service ran. The script uses temporary HOME/CODEX_HOME, an environment whitelist without API tokens/auth-file overrides, and session-only trust for the known scratch hook. It requires that version rather than silently asserting another version's behavior. No verification installs into FysikLab or the running office's checkout.
