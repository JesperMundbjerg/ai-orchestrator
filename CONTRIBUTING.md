# Contributing to Review Inbox

Thanks for helping. Read the [README](README.md), [DESIGN](docs/DESIGN.md), [ARCHITECTURE](docs/ARCHITECTURE.md) and [Code of Conduct](CODE_OF_CONDUCT.md) first. The [API](docs/API.md) and [orchestration reference](docs/ORCHESTRATION.md) describe current integration contracts. Agents should also read [AGENTS](AGENTS.md).

## Set up

Use a git checkout on macOS or Linux, Git, npm and Node >=24.2.0; `.nvmrc` pins the CI baseline to 24.14.0. Windows and the Linux full office are not certified baselines. herdr and logged-in harnesses are not needed for ordinary unit tests or the isolated demo.

```sh
git clone https://github.com/JesperMundbjerg/review-inbox.git
cd review-inbox
npm ci
npm run typecheck
npm test
npm run build
```

Distribution is source-only with `private: true`; do not turn this into an npm publish workflow incidentally. Node executes the erasable TypeScript directly. Do not introduce enums, namespaces or parameter properties. Keep harness-specific behavior outside the UI and preserve the local, no-model-call service boundary.

## Required checks

Before a PR, run all three checks above on the proposed tree. `npm test` runs the `node:test` behavior suite, not browser tests. Add a regression test for behavior changes, especially revision/delivery/ack semantics, identity, request guards and startup side effects. Change [DESIGN](docs/DESIGN.md) invariants only intentionally and explain the corresponding test.

CI runs typecheck, tests and build on macOS and Linux. A passing build is not proof of browser behavior or live harness delivery. State the Node/OS versions, exact commands and actual results in your PR; distinguish a fake-session test from a real integration check. Review `npm audit`: the pinned Pi SDK currently carries a **dev-only transitive `brace-expansion` advisory**. Do not hide that release caveat or use `npm audit fix --force` without reviewing compatibility.

## Isolated UI testing

**Never start a scratch office on port 4870, in your real HOME/data directory, or against a live herdr session.** Changing `INBOX_DATA_DIR` alone does not prevent local harness session reads. Never run `restart-office` for tests: its defaults enable account polling, presence discovery and browser cleanup.

Scratch verification cleanup goes through `scripts/lib/scratch-office.ts` (tracked child group and reverified identity); never `pkill`/`killall`/`pgrep -f`.

For a fictional browser smoke check, after building, use:

```sh
npm run demo
```

It creates a temporary HOME/database, disables all three optional integrations and uses free loopback ports with a nonexistent herdr socket and a false executable. Open its printed URL, answer Lantern's decision, and verify the demo terminal receives it. Check the static ledger preview and planner evidence. Ctrl-C cleans up the servers and scratch data. No real project screenshots should appear.

For a custom scratch service, run from the checkout in a dedicated terminal:

```sh
SCRATCH=$(mktemp -d)
export HOME="$SCRATCH/home" INBOX_DATA_DIR="$SCRATCH/data"
mkdir -p "$HOME"
export HERDR_SOCKET_PATH=/nonexistent HERDR_BIN_PATH=/usr/bin/false
export INBOX_CODEX_ACCOUNT_POLLING=0 INBOX_PRESENCE_DISCOVERY=0 INBOX_BROWSER_CLEANUP=0
# Ask the OS for an available loopback port; startup may need a retry if it races another process.
export INBOX_PORT=$(node --input-type=module -e '
  import { createServer } from "node:net";
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => { if (p === 4870) process.exit(1); console.log(p); });
  });')
: "${INBOX_PORT:?No safe port selected}"
export INBOX_URL="http://127.0.0.1:$INBOX_PORT"
printf 'Scratch inbox: %s\nScratch directory: %s\n' "$INBOX_URL" "$SCRATCH"
node scripts/lib/scratch-office.ts
# After Ctrl-C (the helper stops only its verified child group), and after closing any browser you started:
rm -rf -- "$SCRATCH"
```

Use a browser URL at the printed port. In another terminal, explicitly copy the scratch environment (including HOME, URL and all isolation settings) before running CLI fixtures. Do not submit from an unconfigured agent pane. Keep browser automation headless, write artifacts into the scratch directory, and close browsers in `finally`; do not rely on automatic cleanup. This recipe serves the built UI; rebuild after UI changes. If using Vite, its configured port is 4871 and may fall forward; choose a free port explicitly for concurrent tests and keep its API target on the isolated `INBOX_PORT`.

`test/*.browser.mjs` scripts are additional developer diagnostics, **not** part of `npm test` and not reproducible from the lockfile alone: Playwright is not currently declared there. Use a separately installed Playwright/browser and the scripts' `PLAYWRIGHT_MODULE` override where supported; inspect each script's port, HOME and artifact settings before use. Do not imply those scripts ran merely because CI passed. A browser change needs a stated manual or automated check and neutral evidence.

## Issues and pull requests

- Use the repository's Issues for non-sensitive bugs, with minimal **synthetic** reproduction steps, expected/actual behavior and toolchain versions. Vulnerabilities go privately via [SECURITY](SECURITY.md), not a public issue.
- Discuss significant API, schema, side-effect, dependency or architectural changes before implementation. Keep PRs focused and explain why the change is needed.
- Include behavior tests, required-check results, and relevant documentation updates. For UI changes, include neutral before/after screenshots or a short recording and the interaction you verified. State untested harnesses/platforms honestly.
- Respect module boundaries and concurrent ownership. Do not include unrelated reformatting, generated build output, other contributors' changes, or machine-specific configuration. Maintainers review correctness, privacy, compatibility and evidence; opening a PR is not a promise of merge or a release date.
- Describe schema/API/config compatibility changes, migration and rollback implications. Back up a stopped installation's whole data directory before upgrade testing; see the README's backup/deletion instructions and [CHANGELOG](CHANGELOG.md).

## Never share private data

Do not commit or attach real agent session files, auth files, access tokens, provider keys, cookies, local databases, office logs, handoffs or credential-bearing command output. Do not post real project paths, customer content, conversation text or screenshots containing private work. Use invented names, temporary paths and purpose-made demo evidence. Redact before upload, not after publication; a deleted issue or commit may remain recoverable. If a credential is exposed, revoke/rotate it and follow [SECURITY](SECURITY.md).

New demo/screenshot assets must have clear provenance and redistribution permission. Document them beside the files. Public exports should be independently scanned for secrets and private material; do not rewrite an active shared checkout's history as a publication shortcut.
