# Beyond the office

Use **Front door ↗**, then W to walk out (Shift runs). **Your desk** returns home. The Building's existing sliding door stays open; Ring has a 2.4 m south gate. Existing furniture, garden and agent routes are unchanged.

## Budgets

- Fixed seed `0x51a7d`; 32 m square chunks, 8×8 low-poly heightfield cells. Shared world-space vertex samples and triangle-interpolated walking heights prevent cracks and floating feet.
- Chebyshev radius 4: at most **81 resident chunks**, also the entire work list. No visited cache. One worker request in flight; obsolete replies after a teleport are discarded. One small chunk per worker message/main-thread installation slice. Hidden views request no more work.
- **81 reused terrain mesh slots**, **13 InstancedMesh batches**: five near scenery kinds, three mid kinds, four animal species and water. All geometry/materials/instance buffers are fixed-capacity and disposed on resize/unmount. Three uploads terrain slots lazily as they first enter the frustum; uploaded geometry count then plateaus.
- Near 3×3 chunks: baked multi-crown oaks, tiered pines, rocks, grass and shoreline reeds. The next ring: single-crown/cone trees and simpler rocks. Far: coloured terrain only. The same inexpensive terrain grid at all distances avoids cross-LOD cracks. Fog ends at 112 m outside, before the nearest chunk edge at 128 m.
- A flat opaque water quad for each wet chunk, in one instance batch, naturally clipped by the terrain's depth. No reflection, extra render target, texture or water animation.
- At most **12 animals within 36 m**, generated from local candidates only: deer, rabbits, lake ducks and birds. They wander within their habitat, flee nearby walkers and are dropped behind them. Bodies are whole low-poly coloured instances (hop/bob/bank, no skeleton).
- Trees and water never animate. Animals never request motion frames, and update at most 5 Hz if the camera is still, even if office avatars keep the canvas busy. Pace remains 20/10/5 fps, no hidden-tab rendering. The office's drawing/shadows are hidden once fully behind the outdoor fog, not destroyed.

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
PLAYWRIGHT_MODULE='/Users/jesper/projects/motion video/node_modules/playwright/index.mjs' \
  node test/wilds.browser.mjs
```

It starts only a free-port scratch service with a temporary HOME/data directory and no herdr; Chromium is headless with ANGLE Metal, and both processes close in `finally`. It walks about 1 km with **real Shift+W**, samples renderer.info, CDP JS heap before/after GC, paced frame intervals and CPU frame submission times at start/middle/end, checks the still rate, and captures near/far/lake/animals/front-door/ring-gate screenshots. Evidence goes only to `~/.review-inbox/handoffs/agent-office/wilds/` (or `WILDS_OUTPUT`). It does not open or modify the live inbox database or port 4870.

`?wildsMeasure=1` enables a bounded read-only `window.__wilds.read()` sample ring and a `wilds-measure-pose` event for reproducible screenshot poses. Pose events are used only *after* the measured walk. Neither hook is active in the ordinary office view. CPU times are not GPU frame timings; intentional 50 ms/200 ms pacing is included in the separate frame-interval numbers.
