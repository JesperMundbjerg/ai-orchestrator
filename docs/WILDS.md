# Beyond the office

Use **Front door ↗**, then W to walk out (Shift runs). Walk back through the door to return. The building's sliding door stays open. Building is the only office: there is no layout selector, saved layout choice or founder desk. Existing furniture, garden and agent routes are unchanged.

## Budgets

- Fixed seed `0x51a7d`; 32 m square chunks, 8×8 low-poly heightfield cells. Shared world-space vertex samples and triangle-interpolated walking heights prevent cracks and floating feet.
- Chebyshev radius 4: at most **81 resident chunks**, also the entire work list. No visited cache. One worker request in flight; obsolete replies after a teleport are discarded. One small chunk per worker message/main-thread installation slice. Hidden views request no more work.
- **81 reused terrain mesh slots**, **13 InstancedMesh batches**: five near scenery kinds, three mid kinds, four animal species and water. All geometry/materials/instance buffers are fixed-capacity and disposed on resize/unmount. Three uploads terrain slots lazily as they first enter the frustum; uploaded geometry count then plateaus.
- Near 3×3 chunks: baked multi-crown oaks, tiered pines, rocks, grass and shoreline reeds. The next ring: single-crown/cone trees and simpler rocks. Far: coloured terrain only. The same inexpensive terrain grid at all distances avoids cross-LOD cracks. Fog ends at 112 m outside, before the nearest chunk edge at 128 m.
- A flat opaque water quad for each wet chunk, in one instance batch, naturally clipped by the terrain's depth. No reflection, extra render target, texture or water animation.
- At most **12 animals within 36 m**, generated from local candidates only: deer, rabbits, lake ducks and birds. They wander within their habitat, flee nearby walkers and are dropped behind them. Low-poly coloured instances have rigid local limb pivots: deer swing their legs, rabbits tuck/kick their feet and hop, ducks paddle/bob, and birds flap. A distance-driven cycle and actual movement speed feed two floats per instance to a tiny vertex shader; blocked animals plant their feet. Rabbit cadence is capped while fleeing. No skeleton, skinned mesh, per-limb draw call or per-frame geometry rebuild.
- Trees and water never animate. Animals never request motion frames, and update at most 5 Hz if the camera is still, even if office avatars keep the canvas busy. Only the player's outdoor movement/turning requests 60 fps (with the existing short linger); indoor/office motion stays 20/10/5 fps. Wildlife cannot sustain that promotion, returning indoors immediately restores office pacing, and hidden tabs render nothing. The office's drawing/shadows are hidden outside when its conservative bounds leave the camera frustum or are fully behind fog, not destroyed; indoor off-camera shadow casters remain intact.

First-version limitations: no obstacle collision/navigation was added (the previous walker also had none); lakes can be crossed at water height rather than swimming. Wildlife has no persistent history beyond the resident population. Chunk LOD changes are discrete, not cross-faded. Large-coordinate floating-origin rendering is not yet implemented.

## Checking

Pure behaviour and a fully generated 10 km resident-memory walk:

```sh
node --test test/wilds.test.ts
npm run typecheck
npm test
npm run build
```

Production-browser check:

```sh
scratch_home=$(mktemp -d)
HOME="$scratch_home" WILDS_OUTPUT="$scratch_home/artifacts/wilds" \
  node test/wilds.browser.mjs
```

It starts only a free-port scratch service with a temporary HOME/data directory, `HERDR_SOCKET_PATH=/nonexistent` and `HERDR_BIN_PATH=/usr/bin/false`, and asserts that no live agents are visible. Chromium is headless with ANGLE Metal, and both processes close in `finally`. It walks about 1 km with **real Shift+W**, samples renderer.info, CDP JS heap before/after GC, paced frame intervals and CPU frame submission times at start/middle/end, checks the still rate, and captures near/far/lake/animals/front-door screenshots in Building only. The command above sends evidence to the temporary artifact directory via `WILDS_OUTPUT`; without an override the script uses its caller HOME. Keep the temporary HOME override so no artifacts go into your real inbox data. `PLAYWRIGHT_MODULE` may point to an installed module if normal `playwright` resolution is unavailable. It does not open or modify the live inbox database or port 4870.

`?wildsMeasure=1` enables a bounded read-only `window.__wilds.read()` sample ring (including sequential per-frame samples, instance-rebuild and worker-install CPU time) and a `wilds-measure-pose` event for reproducible screenshot poses. Pose events are used only *after* the measured walk. Neither hook is active in the ordinary office view. CPU times are not GPU frame timings; intentional pacing is included in the separate frame-interval numbers.

## Smooth-walk investigation

`test/wilds-fix.browser.mjs` captures **every rendered frame over a real 1 km Shift+W walk**, not just three small windows. It polls the bounded sample ring, asserts no missing frames, and does no forced GC, screenshot or teleport during the measured kilometre. Run against a production build:

```sh
scratch_home=$(mktemp -d)
HOME="$scratch_home" PLAYWRIGHT_MODULE="$(pwd)/node_modules/playwright/index.mjs" \
  WILDS_RUN=final WILDS_VIDEO=1 node test/wilds-fix.browser.mjs
```

With the command above, evidence stays under the temporary HOME's `.review-inbox/handoffs/agent-office/wilds-fix/`: full frame traces and before/after summaries, screenshots, and timestamped animal clips. The current investigation script requires `PLAYWRIGHT_MODULE`; use the installed dependency's absolute path, not a personal checkout path. Preserve wanted artifacts before deleting the temporary HOME. The scratch-service restrictions above still apply. Post-walk checks cover all four species, looking back at the office, turning away, returning home, and the still rate. The before run used `55b9dff` with only the same measurement hooks added.

The dominant observed problem was **pacing**, not a chunk-generation stall: almost every before frame took over 33 ms, with CPU submission p95 below 1 ms. Chunk swaps, instance rebuilds, fogged far terrain and small terrain-buffer uploads did not produce long hitches in this walk. The wilds already neither cast nor receive shadows. However, the office behind the camera still contributed shadow-map submissions until the player was 112 m beyond its bounds. Frustum-gating that intact group removed those early extra draws. Fixed GPU pools and the worker/sliced installation remain unchanged rather than adding an unproven streaming rewrite.

Measured in headless Chromium 149, ANGLE Metal, **1440×1000 DPR 1**, empty Building office. Frame intervals are presentation/submission intervals; the CPU column starts in the Wilds callback and ends after rendering, not GPU duration. Main-thread installation time is summed between frames. Hardware/browser scheduling can change absolute timings; a populated office's avatar-update cost is not represented by this empty scratch office.

| Full kilometre | Before | After |
|---|---:|---:|
| Frame interval p50 / p95 / worst | 52.3 / 53.1 / 62.0 ms | 17.9 / 25.3 / 28.8 ms |
| CPU submission p95 / worst | 0.9 / 2.0 ms | 0.6 / 1.0 ms |
| Chunk-swap frame p95 / worst | 53.7 / 53.7 ms | 21.1 / 25.2 ms |
| Instance rebuild p95 / worst | 0.4 / 0.4 ms | 0.3 / 0.4 ms |
| Main-thread installation p95 / worst | 1.1 / 2.2 ms | 0.6 / 0.7 ms |
| Draw calls p95 / worst | 42 / 102 | 42 / 44 |
| Triangles p95 / worst | 53,058 / 131,330 | 53,050 / 53,618 |
| Frames over 33.3 ms | 2,122 / 2,131 | 0 / 6,015 |
| Frames over 100 ms | 0 | 0 |

Resident chunks remain 81, terrain slots 81, instance batches 13. Geometry allocation plateaus at 193 by about 225 m in both runs. Still frames remain about 202 ms; leg animation adds no draw calls. A post-walk turn at the same position, 60 m from the origin, restored the office facing it (282 calls with shadows) and culled it facing away (35 calls); reopening the office restores its indoor view as well. Final animal screenshots and timestamp-preserving MP4s cover deer, rabbit, duck and bird.
