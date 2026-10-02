# Review Inbox — agent instructions

This file holds the instructions for every coding agent (Pi, Claude Code, Codex) working in this repository. What the product is and why: [README.md](README.md), [docs/DESIGN.md](docs/DESIGN.md).

## Layout
- `src/server/`: the service. It uses `node:http` and `node:sqlite`, with no runtime dependencies. `inbox.ts` holds the inbox's state rules, `world.ts` the office's (agents, names, projects and standing teams, team status, starting and finishing projects), `worktrees.ts` what git says about a checkout, `adapter.ts` what a project says about itself (`orchestrator.json`), `queue.ts` a project's work queue and the lanes working it, `messages.ts` what is said and handed over between them (messages, deliveries, work and reviews), `activity.ts` what each agent is doing and its helpers (in memory), `crewtree.ts` the founder's crew tree (which harness and model a lead picks for each crew member; a JSON file in the data dir, seeded from `crewtree.default.json`; its types and validation are in `src/shared/crewtree.ts`), `machine.ts` the headless browsers left running on the machine, `usage.ts` the plan's usage meters and each agent's and team's tokens (from reply headers the harnesses pass on and their own session files; never an endpoint), `switch.ts` moving an agent to the other harness (handoff, new pane, takeover, old pane closed last; its own table, picked up after a restart), and `http.ts` is routing and request guards only.
- `src/cli/`: the `inbox` command, for every harness, and the Claude Code hook; `pane.ts` opens a crew pane in herdr, where `nextSplit` (`src/shared/panes.ts`) decides which pane is split so a tab's panes form a grid.
- `integrations/pi/`: the Pi extension (live delivery and activity).
- `src/shared/`: types, the agent-side client and `slug.ts` (a project's worktree and branch name), shared by the service, the CLI, the integrations and the UI.
- `src/ui/`: React + Vite. It talks only to the service's HTTP API. `src/ui/world/` is the 3D office (React Three Fiber), loaded only when opened; `layout.ts` (desks, routes, pipelines round the ring), `building.ts` (the same for the other layout, one building, drawn by `BuildingOffice.tsx`), `planting.ts` (what grows where in its garden, drawn by `Garden.tsx`), `park.ts` (which idle project members are out in that garden and what each does there), `crafts.ts` (the craft station on each desk's place, what it makes and how far along, drawn by `Crafts.tsx`), `corkboard.ts` (what a team's corkboard says and where its stickmen go, painted by `CorkBoard.tsx`) `visits.ts` (who walks to whom) and `pace.ts` (how often the office is drawn: 20 fps while anything moves, 5 when still, none while hidden; `Pace.tsx` drives it) there are pure, and `Talk.tsx` holds the message and work rows the office panels and the team board (`components/TeamBoard.tsx`) share.

## Rules
- The UI never learns about a vendor. Harness-specific behaviour belongs in an integration or the CLI, and the UI branches on `Task.capabilities`.
- No model API calls anywhere, and no agent in the middle.
- The correctness rules in docs/DESIGN.md are invariants. Change them only on purpose, with a test.
- Erasable TypeScript only: Node runs the sources directly, so no enums, namespaces or parameter properties.
- Tests: `node:test` beside the behaviour in `test/*.test.ts`. They test behaviour and invariants, not shapes.
- Before handing work back, run `npm run typecheck`, `npm test` and `npm run build`. Look at any UI change in a browser.
