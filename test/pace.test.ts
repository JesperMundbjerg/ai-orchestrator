import { test } from "node:test";
import assert from "node:assert/strict";
import { AMBLE_LINGER_MS, AMBLING_FPS, LINGER_MS, MOVING_FPS, Pacer, SETTLE_MS, SHADOW_MS, STILL_FPS } from "../src/ui/world/pace.ts";

function assertRate(p: Pacer, now: number, fps: number): void {
  p.drew(now);
  assert.equal(p.nextFrameIn(now, true), 1000 / fps, `rate at ${now} ms`);
}

test("a still office is drawn a few times a second, and smoothly while anything moves", () => {
  const p = new Pacer();
  p.drew(1000);
  assert.equal(p.nextFrameIn(1000, true), 1000 / STILL_FPS);
  p.moved(1000);
  assert.equal(p.nextFrameIn(1000, true), 1000 / MOVING_FPS);
  assert.ok(STILL_FPS <= 6 && MOVING_FPS <= 30, "well below the display's rate");
});

test("walks round the garden are drawn at a middle rate, and anything else moving wins", () => {
  const p = new Pacer();
  p.drew(0);
  p.ambled(0);
  assert.equal(p.nextFrameIn(0, true), 1000 / AMBLING_FPS);
  p.moved(0);
  assert.equal(p.nextFrameIn(0, true), 1000 / MOVING_FPS);
  assert.ok(STILL_FPS < AMBLING_FPS && AMBLING_FPS < MOVING_FPS);
});

test("movement lingers for four seconds, settles at a middle rate, then rests cheaply", () => {
  const p = new Pacer();
  p.moved(0);
  for (const [now, fps] of [[500, 20], [3000, 20], [5000, 10], [10000, 5], [60000, 5]] as const) {
    assertRate(p, now, fps);
  }
  assertRate(p, LINGER_MS - 1, MOVING_FPS);
  assertRate(p, LINGER_MS, AMBLING_FPS);
  assertRate(p, LINGER_MS + SETTLE_MS - 1, AMBLING_FPS);
  assertRate(p, LINGER_MS + SETTLE_MS, STILL_FPS);
});

test("garden ambling lingers for four seconds without using the full moving rate", () => {
  const p = new Pacer();
  p.ambled(0);
  for (const [now, fps] of [[500, 10], [3000, 10], [5000, 5], [10000, 5]] as const) {
    assertRate(p, now, fps);
  }
  assertRate(p, AMBLE_LINGER_MS - 1, AMBLING_FPS);
  assertRate(p, AMBLE_LINGER_MS, STILL_FPS);
});

test("fresh movement restarts the full linger and settling periods", () => {
  const p = new Pacer();
  p.moved(0);
  assertRate(p, 5000, AMBLING_FPS);
  p.moved(5000);
  p.moved(1000); // An older report must not shorten the new linger.
  assertRate(p, 8000, MOVING_FPS);
  assertRate(p, 10000, AMBLING_FPS);
  assertRate(p, 15000, STILL_FPS);
});

test("fresh ambling sustains the middle rate after motion settles, but never the full rate", () => {
  const p = new Pacer();
  p.moved(0);
  p.ambled(7000);
  p.ambled(1000);
  assertRate(p, 10000, AMBLING_FPS);
  assertRate(p, 11000, STILL_FPS);
});

test("the wait counts from the last frame, so movement after a long still wait is drawn at once", () => {
  const p = new Pacer();
  p.drew(0);
  p.moved(150);
  assert.equal(p.nextFrameIn(150, true), 0);
  assert.equal(p.nextFrameIn(20, true), 1000 / MOVING_FPS - 20);
});

test("a hidden office is not drawn at all", () => {
  const p = new Pacer();
  p.moved(0);
  p.ambled(0);
  for (const now of [0, 500, 3000, 5000, 10000, 60000]) {
    assert.equal(p.nextFrameIn(now, false), null);
  }
});

test("shadows are drawn again at most every SHADOW_MS, whatever the frame rate", () => {
  const p = new Pacer();
  const due = Array.from({ length: 20 }, (_, i) => p.shadowsDue(i * 50)).filter(Boolean).length;
  assert.equal(due, Math.ceil((20 * 50) / SHADOW_MS));
});
