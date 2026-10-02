import { test } from "node:test";
import assert from "node:assert/strict";
import { CHUNK, GRID, MAX_CHUNKS, Stream, WATER, away, chunkAt, chunkKey, generate, ground, height, lodAt, noise, wanted, walkingHeight } from "../src/ui/world/wilds/land.ts";
import { ANIMAL_RADIUS, MAX_ANIMALS, populate, stepAnimals, type Animal } from "../src/ui/world/wilds/animals.ts";

const office = { minX: -24, maxX: 24, minZ: -22, maxZ: 21 };
test("fixed seed: chunks, noise and placements reproduce independent of visit order", () => {
  const first = generate(-3, 7, office);
  generate(120, -731, office);
  assert.deepEqual(generate(-3, 7, office), first);
  assert.notDeepEqual(generate(7, -3, office).positions, first.positions);
  assert.equal(noise(-1.125, 0.7), noise(-1.125, 0.7));
  assert.ok(Number.isFinite(noise(-10000.2, 1234.5)));
});
test("negative keys and LOD rings cover a bounded nearest-first neighbourhood", () => {
  assert.deepEqual(chunkAt(-0.01, -32), [-1, -1]);
  assert.equal(chunkKey(-1, 12), "-1,12");
  const ring = wanted(-0.01, 30000);
  assert.equal(ring.length, MAX_CHUNKS);
  assert.equal(new Set(ring.map((w) => w.key)).size, MAX_CHUNKS);
  assert.equal(ring.filter((w) => w.lod === 0).length, 9);
  assert.equal(ring.filter((w) => w.lod === 1).length, 16);
  assert.equal(lodAt(3, 0), 2);
  assert.equal(ring[0]!.key, chunkKey(...chunkAt(-0.01, 30000)));
});
test("terrain joins on every chunk edge, in every LOD, including negative coordinates", () => {
  const edge = (cx: number, cz: number, axis: number, value: number) => {
    const p = generate(cx, cz, office).positions, out = new Map<number, number>();
    for (let i = 0; i < p.length; i += 3) if (p[i + axis] === value) out.set(p[i + (axis === 0 ? 2 : 0)]!, p[i + 1]!);
    return [...out].sort((a, b) => a[0] - b[0]);
  };
  for (const [x, z] of [[-3, -8], [0, 0], [1000, 700]] as const) {
    assert.deepEqual(edge(x, z, 0, CHUNK), edge(x + 1, z, 0, 0));
    assert.deepEqual(edge(x, z, 2, CHUNK), edge(x, z + 1, 2, 0));
  }
  for (let x = -40; x < 80; x += CHUNK / GRID) assert.equal(ground(x, 64, office), height(x, 64, office));
});
test("office lawn is unchanged, planting clears it, lake surface stays flat", () => {
  for (const x of [-24, 0, 24]) for (const z of [-22, 0, 21]) assert.equal(height(x, z, office), -0.025);
  let water = 0, plants = 0;
  for (let z = -5; z <= 5; z++) for (let x = -5; x <= 5; x++) {
    const c = generate(x, z, office);
    water += Number(c.wet);
    for (const p of c.places) {
      plants++;
      assert.ok(away(office, p.x, p.z) >= 7);
      assert.equal(p.y, ground(p.x, p.z, office));
      assert.ok(p.y >= WATER + (p.kind === "shore" ? -0.15 : 0.2));
    }
    if (ground(x * CHUNK, z * CHUNK, office) < WATER) assert.equal(walkingHeight(x * CHUNK, z * CHUNK, office), WATER);
  }
  assert.ok(water > 10 && plants > 1000);
});
test("over a 10 km walk, resident data and queued work remain bounded; returning regenerates", () => {
  const stream = new Stream();
  let maxBytes = 0;
  for (let z = 0; z < 10000; z += CHUNK) {
    stream.move(0, z);
    for (let next = stream.next(); next; next = stream.next()) stream.accept(generate(next.x, next.z, office));
    assert.equal(stream.chunks.size, MAX_CHUNKS);
    assert.equal(stream.desired.length, MAX_CHUNKS);
    assert.equal(stream.next(), undefined);
    const bytes = [...stream.chunks.values()].reduce((n, c) => n + c.positions.byteLength + c.colors.byteLength + c.places.length * 64, 0);
    maxBytes = Math.max(maxBytes, bytes);
    assert.ok(bytes < MAX_CHUNKS * (GRID * GRID * 18 * 4 * 2 + 80 * 64));
  }
  assert.ok(maxBytes < 1_200_000);
  const stale = generate(0, 0, office);
  assert.equal(stream.accept(stale), false);
  stream.move(0, 0);
  assert.equal(stream.accept(stale), true);
  assert.deepEqual(stream.chunks.get("0,0"), generate(0, 0, office));
});
test("teleports replace the work list and reject obsolete worker responses", () => {
  const s = new Stream(); s.move(0, 0);
  const pending = s.next()!;
  s.move(30000, -30000);
  assert.equal(s.accept(generate(pending.x, pending.z, office)), false);
  assert.equal(s.chunks.size, 0);
  assert.equal(s.desired.length, MAX_CHUNKS);
});
test("wildlife is local and capped, flees the walker, and stays in its habitat", () => {
  let animals: Animal[] = [];
  for (let z = 80; z < 3000; z += 8) {
    animals = populate(animals, 0, z, office);
    assert.ok(animals.length <= MAX_ANIMALS);
    assert.ok(animals.every((a) => Math.hypot(a.x, a.z - z) < ANIMAL_RADIUS));
    stepAnimals(animals, 0, z, 0.2, office);
    for (const a of animals) if (a.kind === "duck") assert.equal(a.y, WATER);
  }
  let dry: [number, number] = [0, 80];
  while (ground(...dry, office) <= WATER + 1) dry[1] += 8;
  const a: Animal = { id: "flee", kind: "deer", x: dry[0], z: dry[1], y: 0, yaw: 0, homeX: dry[0], homeZ: dry[1], phase: 0, fleeing: false };
  stepAnimals([a], dry[0] - 1, dry[1], 0.2, office);
  assert.equal(a.fleeing, true);
  assert.ok(a.x > dry[0]);
  assert.deepEqual(populate([], 0, 120, office), populate([], 0, 120, office));
  assert.deepEqual(populate([a], 30000, -30000, office).filter((b) => b.id === a.id), []);
});
