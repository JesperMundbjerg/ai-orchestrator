# Review Inbox — agent instructions

Read [README](README.md) for onboarding, [CONTRIBUTING](CONTRIBUTING.md) for checks and safe testing, and [DESIGN](docs/DESIGN.md) for correctness invariants. [ARCHITECTURE](docs/ARCHITECTURE.md) maps modules; [API](docs/API.md) documents the implemented protocol.

## Boundaries

- `src/server/`: local HTTP/SQLite service, inbox state, office state and integrations. Keep routing/guards in `http.ts`; behavior belongs in its owning module.
- `src/cli/` and `integrations/pi/`: harness-specific behavior and agent delivery.
- `src/shared/`: types, client and pure contracts shared across service, CLI, integrations and UI.
- `src/ui/`: React/Vite; `src/ui/world/` is the lazy-loaded 3D office. UI talks only to the service and branches on `Task.capabilities`, not vendors.

## Rules

- No model API calls and no reasoning agent in the middle. Account usage polling is a separate, explicit opt-in.
- Change DESIGN invariants only deliberately, with a behavior test. Use `node:test` in `test/*.test.ts`; test behavior, not incidental shapes.
- Erasable TypeScript only: Node runs sources directly. No enums, namespaces or parameter properties.
- Respect concurrent file ownership; do not stage, revert or overwrite someone else's work.
- **Scratch offices must be isolated:** temporary HOME and data directory, a free port (never `4870`), `HERDR_SOCKET_PATH=/nonexistent`, `HERDR_BIN_PATH=/usr/bin/false`, and all three integration opt-ins explicitly `0`. Never use the real `~/.review-inbox` or `restart-office` for tests. A different data directory alone does not isolate session reads.
- Scratch verification cleanup goes through `scripts/lib/scratch-office.ts` (tracked child group and reverified identity); never `pkill`/`killall`/`pgrep -f`.
- Before handoff: `npm run typecheck`, `npm test`, `npm run build`. Look at UI changes in an isolated browser; report what was actually checked. Never share real sessions, credentials or private project evidence.
