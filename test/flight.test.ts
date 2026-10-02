import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceFlap, birdFraming, FLIGHT_HEIGHT, flapRate, flightMotion, flightPose } from "../src/ui/world/flight.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-10, `${a} ≈ ${b}`);

test("hover stays above head height, beating quickly without a forward lean", () => {
  assert.ok(FLIGHT_HEIGHT > 2 && FLIGHT_HEIGHT < 3);
  const poses = Array.from({ length: 200 }, (_, i) => flightPose(i / 100, advanceFlap(0, i / 100, 0, false), 0));
  assert.ok(poses.every(p => p.lean === 0 && Math.abs(p.bob) <= 0.065));
  assert.ok(Math.max(...poses.map(p => p.bob)) > 0.06);
  assert.ok(Math.min(...poses.map(p => p.bob)) < -0.06);
  assert.ok(Math.max(...poses.map(p => p.flap)) > 1);
  assert.ok(Math.min(...poses.map(p => p.flap)) < -0.8);
  assert.ok(flapRate(0, false) > flapRate(1, false));
  assert.equal(flapRate(0, true), flapRate(0, false), "Shift alone is still hovering");
});

test("cruising leans forward with a gentle swoop, and Shift speeds the wings", () => {
  for (let i = 0; i < 1000; i++) {
    const pose = flightPose(i / 60, i, 1);
    assert.ok(pose.lean >= -0.325 && pose.lean <= -0.235);
    assert.ok(Math.abs(pose.bob) <= 0.14);
    assert.ok(Math.abs(pose.flap) <= 0.92);
  }
  assert.ok(flapRate(1, true) > flapRate(1, false));
  assert.ok(flightPose(0.3, 0, 1).bob > flightPose(0.3, 0, 0).bob);
});

test("phase integrates continuously across frame rates and speed changes", () => {
  let phase = 0;
  for (let i = 0; i < 60; i++) phase = advanceFlap(phase, 1 / 60, 1, false);
  near(phase, advanceFlap(0, 1, 1, false));
  near(advanceFlap(phase, 0, 1, true), phase);
  near(advanceFlap(phase, -1, 0, false), phase);
  const cruising = advanceFlap(phase, 0.01, 1, false);
  const sprinting = advanceFlap(phase, 0.01, 1, true);
  assert.ok(sprinting > cruising);
  for (const t of [0, 0.016, 1, 1e6]) {
    const next = advanceFlap(phase, t, 0, false);
    assert.ok(next >= 0 && next < 2 * Math.PI);
  }
});

test("motion eases into flight and back to hover without a pose snap", () => {
  let motion = 0;
  for (let i = 0; i < 60; i++) motion = flightMotion(motion, true, 1 / 60);
  near(motion, flightMotion(0, true, 1));
  assert.ok(motion > 0.99 && motion < 1);
  const slowing = flightMotion(motion, false, 1 / 60);
  assert.ok(slowing > 0 && slowing < motion);
  assert.ok(flightMotion(motion, false, 1) < 0.001);
  assert.equal(flightMotion(0.5, true, 0), 0.5);
  assert.deepEqual(flightPose(2, 1, -1), flightPose(2, 1, 0));
  assert.deepEqual(flightPose(2, 1, 2), flightPose(2, 1, 1));
});

test("bird remains close and below the viewpoint with stable framing at every zoom", () => {
  const normal = birdFraming(62);
  assert.equal(normal.scale, 1);
  for (const fov of [18, 32, 62, 80]) {
    const frame = birdFraming(fov);
    assert.equal(frame.distance, 3.2, "zoom cannot leave the bird far away");
    assert.ok(frame.drop > 0);
    near(frame.drop / frame.scale, normal.drop);
    near(frame.scale / Math.tan(fov * Math.PI / 360), 1 / Math.tan(62 * Math.PI / 360));
  }
});
