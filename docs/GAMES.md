# Lounge games and reachable seats

The building uses `lounge.ts` for sofa positions and front approaches. `building.ts` opens the four formerly enclosed reading nooks through their neighbouring bay's front strip; the sofas face that opening and the plants stand behind them. Kitchen stools have a little more table clearance.

`seats.ts` inventories every physical seat, including unused chairs, plus occupied craft-station places. `test/games.test.ts` samples entrance routes with body clearance against walls, furniture, garden beds and other seats, in the building at several sizes. Only the final approach may enter the destination seat itself. The established building route tests remain in place too.

`games.ts` chooses two idle pool players and one darts player, retaining eligible players as the world updates. Project members use `park.ts`'s one-minute idle rule; working, done, offline, blocked, queued and waiting-on-founder agents cannot play. Creative reviews take precedence in the view. Remaining idle agents can use the lounge and reading-nook seats, or the existing garden activities.

Six pool plays and six three-dart rounds are baked once as 20 Hz frame arrays. Positions, arcs, lean/arm poses, cue movement and brief scores are lookups; runtime has no physics, random sampling or timers. Pool turns alternate sides and seeded identities pick the play. `GamePlayback` waits for actual arrival (both players for pool), then starts their common clock. Departure cancels it. `Games.tsx` draws low-poly furniture, balls, cue, darts and cached score sprites; `Avatar.tsx` uses the same clock for poses. Only active games promote the existing pacer, which still draws nothing in a hidden tab.

## Headless check

Build, then run:

```sh
PLAYWRIGHT_MODULE='/absolute/path/to/playwright/index.mjs' node scripts/check-games.mjs
```

The check targets the building, the only office, without a layout selector. It creates a disposable database and HOME, explicitly sets `HERDR_SOCKET_PATH=/nonexistent` and `HERDR_BIN_PATH=/usr/bin/false`, runs a scratch HTTP office on a free port other than 4870, and supplies twenty-three idle agents without herdr or account reads. It uses headless Chromium only, checks default and legacy-storage opening without a selector or founder desk, garden occupancy, front-door walking, moving balls / three landed darts / score visibility / immediate working-state departure, and closes the browser, HTTP server and database in `finally`. Screenshots default to `~/.review-inbox/handoffs/agent-office/games/` (override with `GAMES_SCREENSHOTS`). No live inbox state is read or changed.
