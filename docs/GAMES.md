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

## Gym

The south-east corner's square holds a gym along its outer wall, behind the reading nook's sofa, so it stays out of the opening views. It has a rubber floor, a lifting platform, a squat stand, a flat bench with uprights, a pull-up rig and a plate tree. `furnishGym` adds the boxes to the building's instanced furniture. `Gym.tsx` draws the bars and plates on shared geometry and materials.

`gym.ts` chooses lifters after the games. Eligibility follows the same rules, and nobody plays and trains at once. At most a third of the eligible agents train, and only one agent uses each station. Lifters stay at their station while they are eligible. The others are ordered by a hash of their id, and each takes the first free station starting from a hashed preference. The lifts are keyframed in body units and eased:
- the platform runs three snatches, then two clean and jerks, each followed by a rest;
- the squat stand, bench and pull-up rig each run a set of five, then a six-second rest.

`GymPlayback` starts a lifter's clock once they are at their station and stops it when they leave, the same way games do. The avatar's rig has knees, ankles and elbows. A two-bone reach keeps the hands on the bar, and the bar follows the pose. Only a moving lift promotes the pacer.

`test/gym.test.ts` covers station choice, lift timing and continuity, hands on the bar across heights and builds, and clear walking routes. The browser check (`npm run build`, then `PLAYWRIGHT_MODULE=… node test/gym.browser.mjs`) runs `test/gym-office.fixture.ts` through the scratch launcher on a free port, with herdr and the integrations off. It holds the clock at each lift's phases and measures hand-to-bar distance in the scene. It takes desktop and phone screenshots and records a video, then gives everyone work and checks that the lifters leave. Output goes to `~/.review-inbox/handoffs/agent-office/gym/` (override with `SHOTS`).

## Ping pong

The south-west corner's square holds a full-size ping pong table along its outer wall, behind the reading nook's sofa, mirrored from the gym's corner (`cornerFrame` in `gym.ts`). `furnishPingPong` adds the top, lines, net and legs to the instanced furniture. `PingPong.tsx` draws the ball, plus a paddle in each player's right hand.

`pingpong.ts` chooses players after the games and the gym, with the same eligibility (`pingEligible`). Two agents play, paired by a hash of their id. If one player leaves, the other keeps their end and the next eligible agent takes the free one. An agent who would be alone plays a regular instead (below): when only one agent is idle at all they go to the table rather than to darts, and one left over after the games and the gym does the same. `PingPlayback` starts the rally once both players are at the table and stops it when either walks off. One round is two points, baked once:
- the ball is held, tossed and served, bouncing on the server's side and then the other;
- each rally shot bounces once on the far side;
- the last shot is caught, and the catcher serves next.

Every flight is a true parabola under gravity, with bounce restitution of 0.77–0.89. Each paddle swings back, meets the ball and follows through. `playerPose` crouches each player, steps them across to the ball, reaches the blade with the gym's two-bone reach and turns their head to follow the ball. Only a rally promotes the pacer.

`test/gym-pingpong.test.ts` covers pairing, the clock, bounce sides, net clearance, gravity, restitution, paddle contact, continuity, reach and clear routes. The browser check (`PLAYWRIGHT_MODULE=… node test/gym-pingpong.browser.mjs`) uses the same scratch fixture as the gym's. It holds the clock at the serve, its bounces and the rally's hits, and measures ball-to-blade distance and bounce positions in the scene. It takes desktop and phone screenshots and records videos, then checks that the players leave and the ball comes to rest. Output goes to `~/.review-inbox/handoffs/agent-office/gym/pingpong/`.

## Regulars

The gym and the table have regulars: six people from the neighbourhood (`regulars.ts`, drawn by `Regulars.tsx`) who use them whenever no agent does, so the corners are alive while everyone works. They exist only in the browser. There is no server state, no `world_agents` row and no herdr pane behind them. They are never in the plan's spots, so nothing that lists, counts, messages or answers agents sees them: not the projects panel, the header's agent count, Needs you or a team panel. Only the gym's bars and the table's rally see them beside the agents.

- **Who and where.** The cast is fixed: Ottilie (platform), Kwabena (squat stand), Marisol (bench), Thandiwe (pull-up rig), Brigitta and Ignatius (one end of the table each). Each has a look derived from their id, with their own clothes, so the gym's bars still fit their height. A regular is at their home while no agent has it. An agent taking it sends them aside: Ottilie and Kwabena stretch on mats in front of the gym, Marisol and Thandiwe go to the water cooler, and Brigitta and Ignatius watch from across the table's lane. They walk there by the corner's own lane and walk back when the agent leaves.
- **Partnering.** `partnerLone` puts a lone idle agent at the table (keeping the end they had). The regular whose end is free plays them on the same `PingPlayback` clock two agents use, and the other regular watches. Once a second agent is free, the agents go to the lounge games or the table together, and both regulars are back at their ends.
- **Touches.** A lifter sips from a bottle once a round in the rest after their program's last lift, standing, with both hands off the bar (not on the bench). After each point the player who did not catch the ball punches the air with their free hand, and watchers cheer and follow the ball with their heads. The two at the cooler high five every fourteen seconds on the office's clock, and otherwise sip from paper cups. The stretchers reach up, then fold to their toes.
- **Telling them apart.** A regular has no status lamp and a small light name pill with no project, harness or status line. Clicking one shows a one-line card ("Kwabena · Regular at the gym (not an agent)") with only a close button, never an agent's panel.
- **Cost.** They use the agents' rig (`Body`) and the shared lift and rally helpers (`liftRig` and `playRig` in `Avatar.tsx`). The cooler, mats, bottles and cups share one geometry and one material each, and a frame allocates nothing. Lifts and the rally promote the pacer as the agents' do. The small touches ask only for the ambling rate.

`test/regulars.test.ts` covers the cast, filling every station and end, stepping aside and back along the lane, partnering a lone agent, never being chosen as an agent, and the touches' timing (a sip only with the hands off the bar and still). The browser check (`npm run build`, then `PLAYWRIGHT_MODULE=… node test/regulars.browser.mjs`) runs three scratch offices from the gym fixture in turn: nobody idle, one idle agent and twenty-three. In each it checks who is where, that no regular is an avatar, in the count or in the projects panel, and that a click shows the card and no agent panel. It takes screenshots and videos into `~/.review-inbox/handoffs/agent-office/regulars/` (override with `SHOTS`).
