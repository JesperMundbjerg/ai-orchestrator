import { test } from "node:test";
import assert from "node:assert/strict";
import { applySplit, nextSplit, type PaneRect } from "../src/shared/panes.ts";

const tab = (width: number, height: number): PaneRect[] => [{ id: "p0", x: 0, y: 0, width, height }];

/** Opens `count` panes one after another, as `inbox pane` does, and returns the layout and the splits made. */
function grow(panes: PaneRect[], count: number) {
  const splits = [];
  for (let i = 0; i < count; i++) {
    const split = nextSplit(panes);
    splits.push(split);
    panes = applySplit(panes, split, `n${panes.length}`);
  }
  return { panes, splits };
}

const columns = (panes: PaneRect[]) => new Set(panes.map((p) => p.x)).size;
const rows = (panes: PaneRect[]) => new Set(panes.map((p) => p.y)).size;

test("a lone pane is split right, and then each of the two columns down: a 2x2 grid", () => {
  const { panes, splits } = grow(tab(150, 48), 3);
  assert.equal(splits[0]!.direction, "right");
  assert.deepEqual(splits.slice(1).map((s) => s.direction), ["down", "down"]);
  assert.equal(panes.length, 4);
  assert.equal(columns(panes), 2);
  assert.equal(rows(panes), 2);
  for (const p of panes) assert.deepEqual([p.width, p.height], [75, 24]);
});

test("the grid then grows to three panes in each of the two rows, not a stack", () => {
  const { panes } = grow(tab(150, 48), 5);
  assert.equal(panes.length, 6);
  assert.equal(rows(panes), 2);
  // Each row holds three panes.
  for (const y of [0, 24]) assert.equal(panes.filter((p) => p.y === y).length, 3);
});

test("one to nine panes in a wide tab never make a sliver", () => {
  for (let n = 1; n <= 9; n++) {
    const { panes } = grow(tab(150, 48), n - 1);
    assert.equal(panes.length, n);
    for (const p of panes) {
      const shape = Math.max(p.width, p.height * 2) / Math.min(p.width, p.height * 2);
      assert.ok(shape <= 4, `${n} panes: ${p.id} is ${p.width}x${p.height}`);
      assert.ok(p.width >= 18 && p.height >= 6, `${n} panes: ${p.id} is ${p.width}x${p.height}`);
    }
    // Never a single column of three or more.
    if (n >= 3) assert.ok(columns(panes) >= 2, `${n} panes are one column`);
  }
});

test("a narrow tab is split down first rather than into two slivers", () => {
  assert.deepEqual(nextSplit(tab(70, 48)), { pane: "p0", direction: "down" });
});

test("panes of a size that differs by a cell count as equal, and the emptier row goes first", () => {
  const panes: PaneRect[] = [
    { id: "a", x: 0, y: 0, width: 37, height: 24 },
    { id: "b", x: 38, y: 0, width: 38, height: 24 },
    { id: "c", x: 77, y: 0, width: 73, height: 24 },
    { id: "d", x: 0, y: 24, width: 75, height: 24 },
    { id: "e", x: 75, y: 24, width: 75, height: 24 },
  ];
  assert.deepEqual(nextSplit(panes), { pane: "d", direction: "right" });
});

test("it splits the largest pane wherever it is and names one that exists", () => {
  const panes: PaneRect[] = [
    { id: "small", x: 0, y: 0, width: 50, height: 10 },
    { id: "big", x: 50, y: 0, width: 100, height: 48 },
  ];
  assert.equal(nextSplit(panes).pane, "big");
  assert.throws(() => nextSplit([]));
});
