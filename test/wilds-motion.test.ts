import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINGER_MS, MOVING_FPS, OUTDOOR_FPS, Pacer, STILL_FPS } from '../src/ui/world/pace.ts';
import { gaitPose, limbAngle } from '../src/ui/world/wilds/gait.ts';
import { stepAnimals, type Animal, type Species } from '../src/ui/world/wilds/animals.ts';
import { ground, WATER } from '../src/ui/world/wilds/land.ts';

const office = { minX: -24, maxX: 24, minZ: -22, maxZ: 21 };
test('only outdoor player movement earns 60 fps; returning indoors and hiding remain cheap', () => {
  const p = new Pacer();
  p.outside(true); p.moved(100); p.drew(100);
  assert.equal(p.nextFrameIn(100, true), 1000 / MOVING_FPS, 'office avatars do not earn outdoor rate');
  p.walkedOutside(100);
  assert.equal(p.nextFrameIn(100, true), 1000 / OUTDOOR_FPS);
  p.walkedOutside(0);
  assert.equal(p.lastOutdoorMotion, 100, 'old reports do not shorten linger');
  assert.equal(p.nextFrameIn(100, false), null);
  p.outside(false);
  assert.equal(p.nextFrameIn(100, true), 1000 / MOVING_FPS);
  p.outside(true); p.moved(100 + LINGER_MS);
  p.drew(100 + LINGER_MS);
  assert.equal(p.nextFrameIn(100 + LINGER_MS, true), 1000 / MOVING_FPS, 'avatars cannot extend outdoor linger');
  p.drew(15000);
  assert.equal(p.nextFrameIn(15000, true), 1000 / STILL_FPS);
});

test('rigid deer legs alternate diagonal pairs; bird wings mirror; stopped limbs plant', () => {
  const phase = Math.PI / 2;
  const one = limbAngle(phase, 1, .65, 0), other = limbAngle(phase, 1, .65, Math.PI);
  assert.ok(Math.abs(one + other) < 1e-12);
  assert.ok(one > .6 && other < -.6);
  assert.equal(limbAngle(phase, 0, .65, 0), 0);
  assert.equal(limbAngle(phase, 1, .85, 0), -limbAngle(phase, 1, -.85, 0));
});

test('rabbit hops and duck bobs are speed-driven, bounded, and stop at zero speed', () => {
  for (const kind of ['deer', 'rabbit', 'duck', 'bird'] as Species[]) {
    for (let phase = 0; phase < Math.PI * 2; phase += .1) {
      assert.equal(gaitPose(kind, phase, 0).hop, 0);
      assert.equal(gaitPose(kind, phase, 0).strength, 0);
      const fast = gaitPose(kind, phase, 4);
      assert.equal(fast.strength, 1);
      assert.ok(Math.abs(fast.hop) <= .22);
    }
  }
  assert.ok(gaitPose('rabbit', Math.PI / 2, .45).hop > .2);
  assert.equal(gaitPose('rabbit', Math.PI * 1.5, .45).hop, 0, 'grounded half of hop');
  assert.ok(gaitPose('deer', 0, .45).strength < gaitPose('deer', 0, 3.8).strength);
});

function deer(x: number, z: number): Animal {
  return { id: 'test', kind: 'deer', x, z, y: ground(x, z, office), yaw: 0, homeX: x, homeZ: z, phase: 0, gait: 0, fleeing: false };
}
test('cycle advances with actual distance: fleeing speeds up, blocked animals do not glide', () => {
  let z = 80;
  while (ground(0, z, office) < WATER + 1) z += 8;
  const slow = deer(0, z), fast = deer(0, z);
  stepAnimals([slow], 100, z, .1, office);
  stepAnimals([fast], -1, z, .1, office);
  assert.equal(slow.speed, .45); assert.equal(fast.speed, 3.8);
  assert.ok(fast.gait! > slow.gait! * 8);
  assert.ok(Math.abs(slow.gait! - Math.hypot(slow.x, slow.z - z) * 5) < 1e-10);
  const blocked = deer(0, 0);
  stepAnimals([blocked], 100, 100, .2, office);
  assert.equal(blocked.speed, 0); assert.equal(blocked.gait, 0);
  assert.equal(blocked.x, 0); assert.equal(blocked.z, 0);
  assert.equal(gaitPose(blocked.kind, blocked.gait!, blocked.speed!).strength, 0);
});

test('gait remains bounded over a long walk and time steps cannot teleport animals', () => {
  const a = deer(0, 120);
  for (let i = 0; i < 1000; i++) {
    const { x, z } = a;
    stepAnimals([a], a.x - 1, a.z, 100, office);
    assert.ok(Math.hypot(a.x - x, a.z - z) <= 3.8 * .22 + 1e-10);
    assert.ok(a.gait! >= 0 && a.gait! < Math.PI * 2);
  }
});
