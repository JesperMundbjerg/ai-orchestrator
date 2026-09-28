# Review Inbox — agent instructions

This file holds the instructions for every coding agent (Pi, Claude Code, Codex) working in this repository. What the product is and why: [README.md](README.md), [docs/DESIGN.md](docs/DESIGN.md).

## Layout
- `src/server/`: the service. It uses `node:http` and `node:sqlite`, with no runtime dependencies. `inbox.ts` holds the inbox's state rules, `world.ts` the office's (agents, names, teams, team status and instructions), and `http.ts` is routing and request guards only.
- `src/cli/`: the `inbox` command, for every harness, and the Claude Code hook.
- `integrations/pi/`: the Pi extension (live delivery).
- `src/shared/`: types and the agent-side client, shared by the service, the CLI, the integrations and the UI.
- `src/ui/`: React + Vite. It talks only to the service's HTTP API. `src/ui/world/` is the 3D office (React Three Fiber), loaded only when opened; `layout.ts` there is pure and tested.

## Rules
- The UI never learns about a vendor. Harness-specific behaviour belongs in an integration or the CLI, and the UI branches on `Task.capabilities`.
- No model API calls anywhere, and no agent in the middle.
- The correctness rules in docs/DESIGN.md are invariants. Change them only on purpose, with a test.
- Erasable TypeScript only: Node runs the sources directly, so no enums, namespaces or parameter properties.
- Tests: `node:test` beside the behaviour in `test/*.test.ts`. They test behaviour and invariants, not shapes.
- Before handing work back, run `npm run typecheck`, `npm test` and `npm run build`. Look at any UI change in a browser.
