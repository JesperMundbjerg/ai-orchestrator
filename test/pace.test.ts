import { test } from "node:test";
import assert from "node:assert/strict";
import { AMBLING_FPS, LINGER_MS, MOVING_FPS, Pacer, SHADOW_MS, STILL_FPS } from "../src/ui/world/pace.ts";

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

test("frames stay at the moving rate a moment after the last movement, then drop", () => {
  const p = new Pacer();
  p.moved(0);
  p.drew(LINGER_MS - 10);
  assert.equal(p.nextFrameIn(LINGER_MS - 10, true), 1000 / MOVING_FPS);
  p.drew(LINGER_MS + 10);
  assert.equal(p.nextFrameIn(LINGER_MS + 10, true), 1000 / STILL_FPS);
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
  assert.equal(p.nextFrameIn(0, false), null);
});

test("shadows are drawn again at most every SHADOW_MS, whatever the frame rate", () => {
  const p = new Pacer();
  const due = Array.from({ length: 20 }, (_, i) => p.shadowsDue(i * 50)).filter(Boolean).length;
  assert.equal(due, Math.ceil((20 * 50) / SHADOW_MS));
});
