# Security policy

## Supported versions

Review Inbox is pre-1.0 and distributed as a git checkout, not an npm package. Security fixes target the **latest `main` checkout only**; older commits, tags and forks have no promised backports. Before upgrading, back up the stopped installation's whole data directory and review [CHANGELOG](CHANGELOG.md). An older binary may not understand a migrated database.

## Private reporting

Use the official repository's **Security → Advisories → Report a vulnerability** (GitHub private vulnerability reporting):

[Report privately](https://github.com/JesperMundbjerg/review-inbox/security/advisories/new)

Do not open a public issue or PR containing exploit details or sensitive data. This public repository/reporting route is part of the publication setup; until it is available, do not treat a broken link as permission to disclose publicly. Keep the report private and wait for the official repository's private reporting channel. There is no guaranteed response deadline or bounty. Coordinate any public disclosure with maintainers through the advisory.

Include the affected commit/version, OS and Node version, which opt-ins were enabled, expected/actual behavior, impact and minimal reproduction steps using synthetic inputs. A small proof of concept is more useful than a full session archive.

## Local-only trust boundary

The service binds to loopback and assumes trusted local users, processes, agents, checkouts and herdr sessions. It is **not a multi-user authorization boundary**. Session identifiers select a delivery destination; they are not credentials. Browser Origin checks apply when Origin is present; CLI/server requests without it are accepted as local trusted clients.

There is **no security guarantee for remote access, shared-host deployments, reverse proxies, tunnels or exposing the API to a network**. Do not expose it that way or treat Origin validation as authentication. The development proxy is for local UI work, not a deployment recommendation.

The service has your user's file/process permissions. It reads local harness usage/session files, keeps potentially sensitive review and office state, and can perform git/worktree and herdr actions. Previews/evidence are supplied by agents and should be trusted before opening. Account polling, presence discovery and browser cleanup are independent opt-ins on ordinary startup; **the full-office restart script defaults them on**. A separate data directory alone does not isolate session or credential reads. Read the [README trust section](README.md#trust-and-privacy--read-before-starting) and use the [contributor isolation recipe](CONTRIBUTING.md#isolated-ui-testing) for experiments.

## Redact reports before sending

- Replace usernames, absolute checkout/home paths, repository/customer names, agent/session identifiers and private conversation content with consistent fictional values.
- Remove tokens, API keys, auth headers, cookies, credential URLs and auth-file contents completely. Do not send `~/.codex/auth.json`, harness session transcripts, the inbox database, handoff directories or unfiltered logs.
- Reproduce with a temporary HOME and invented fixtures. Crop/redraw screenshots and check terminal output, URL query strings, browser tabs and metadata for private information. Prefer purpose-made evidence to blurring a real screen.
- Share only the minimum necessary snippet. Redaction must preserve the behavior being reported, but never a usable credential. If a credential was exposed, revoke/rotate it promptly; deleting the attachment does not undo exposure.

## Known release caveat

The pinned Pi SDK currently carries a **dev-only transitive `brace-expansion` advisory**. It is not a production service dependency, but contributor/tooling installs still include it. Passing typecheck/tests/build does not resolve the advisory. Review current `npm audit` output before release; a compatible SDK/dependency update should be verified rather than applying forced upgrades blindly.
