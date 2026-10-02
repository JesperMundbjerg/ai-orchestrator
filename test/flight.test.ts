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
  assert.ok(Math.max(...poses.map(p => p.flap)) > 0.55);
  assert.ok(Math.min(...poses.map(p => p.flap)) < -0.39);
  assert.ok(poses.every(p => p.flap >= -0.4 && p.flap <= 0.56));
  assert.ok(flapRate(0, false) >= 1.5 && flapRate(0, false) <= 2);
  assert.equal(flapRate(0, false), flapRate(1, false));
  assert.equal(flapRate(0, true), flapRate(0, false), "Shift alone is still hovering");
});

test("cruising leans forward with a gentle swoop but never speeds up the wings", () => {
  for (let i = 0; i < 1000; i++) {
    const pose = flightPose(i / 60, i, 1);
    assert.ok(pose.lean >= -0.325 && pose.lean <= -0.235);
    assert.ok(Math.abs(pose.bob) <= 0.14);
    assert.ok(pose.flap >= -0.26 && pose.flap <= 0.42);
    assert.ok(pose.fold >= 0 && pose.fold <= 0.65);
  }
  for (const motion of [-1, 0, 0.25, 0.5, 1, 2]) {
    for (const sprint of [false, true]) {
      assert.equal(flapRate(motion, sprint), 1.7, "one slow rate in every state");
      near(advanceFlap(0.5, 0.1, motion, sprint), advanceFlap(0.5, 0.1, 0, false));
    }
  }
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
  near(sprinting, cruising);
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

test("wrists fold on recovery and open for a gentle flight glide, without a phase-wrap snap", () => {
  const tau = 2 * Math.PI;
  assert.ok(flightPose(0, Math.PI / 2, 0).fold > 0.6);
  near(flightPose(0, Math.PI * 1.5, 0).fold, 0);
  for (const motion of [0, 0.5, 1]) {
    const a = flightPose(0, tau - 1e-7, motion), b = flightPose(0, 1e-7, motion);
    assert.ok(Math.abs(a.flap - b.flap) < 1e-6);
    assert.ok(Math.abs(a.fold - b.fold) < 1e-6);
    for (let i = 0; i <= 100; i++) {
      const pose = flightPose(0, tau * i / 100, motion);
      assert.ok(pose.fold >= 0 && pose.fold <= 0.65);
    }
  }
  for (const fraction of [0.72, 0.8, 0.9, 0.99]) {
    const glide = flightPose(0, fraction * tau, 1);
    near(glide.flap, 0.08);
    near(glide.fold, 0);
  }
  for (const sprint of [false, true]) {
    near(advanceFlap(0, 1 / flapRate(0, sprint), 0, sprint), 0);
  }
});

test("bird remains close and below the viewpoint with stable framing at every zoom", () => {
  const normal = birdFraming(62);
  assert.equal(normal.scale, 0.62, "38% smaller at the same camera distance");
  assert.equal(normal.drop, 0.55, "shrinking must not raise the bird into the sightline");
  for (const fov of [18, 32, 62, 80]) {
    const frame = birdFraming(fov);
    assert.equal(frame.distance, 3.2, "zoom cannot leave the bird far away");
    assert.ok(frame.drop > 0);
    near(frame.drop / frame.scale, normal.drop / normal.scale);
    near(frame.scale / Math.tan(fov * Math.PI / 360), 0.62 / Math.tan(62 * Math.PI / 360));
  }
});
