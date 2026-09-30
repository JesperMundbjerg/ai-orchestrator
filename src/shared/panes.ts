// Where a new pane goes so that a tab's panes form a grid: two columns first, then two rows
// each, then the grid keeps growing instead of one pane being cut into an ever thinner stack.
// Pure: it gets the panes' rectangles (as `herdr pane layout` reports them, in terminal cells)
// and says which pane to split and in which direction.

export interface PaneRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Split {
  pane: string;
  direction: "right" | "down";
}

/** A terminal cell is about twice as tall as it is wide; sizes are compared as they look. */
const CELL_ASPECT = 2;

const looks = (p: PaneRect) => ({ w: p.width, h: p.height * CELL_ASPECT });
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

/**
 * The largest pane as it looks is split, along its longer side, so panes stay near square; a
 * pane as wide as it looks tall is split right, which makes a lone pane two columns and those
 * two each two rows. Of equally large panes the one in the row with the fewest panes goes
 * first (a row fills up before another gets a fourth), then the one nearest the top left.
 */
export function nextSplit(panes: PaneRect[]): Split {
  if (!panes.length) throw new Error("no pane to split");
  const rowCount = (p: PaneRect) => panes.filter((q) => overlaps([p.y, p.y + p.height], [q.y, q.y + q.height])).length;
  const area = (p: PaneRect) => looks(p).w * looks(p).h;
  // Sizes are whole cells, so panes that came from one split differ by one; those count as equal.
  const largest = Math.max(...panes.map(area));
  const tied = panes.filter((p) => area(p) >= largest * 0.93);
  const pane = tied.sort((a, b) => rowCount(a) - rowCount(b) || a.y - b.y || a.x - b.x)[0]!;
  const { w, h } = looks(pane);
  return { pane: pane.id, direction: w >= h ? "right" : "down" };
}

/** Where the new pane ends up, for a simulation in tests: the pane is cut in half along the direction. */
export function applySplit(panes: PaneRect[], split: Split, newId: string): PaneRect[] {
  return panes.flatMap((p) => {
    if (p.id !== split.pane) return [p];
    if (split.direction === "right") {
      const first = Math.ceil(p.width / 2);
      return [{ ...p, width: first }, { id: newId, x: p.x + first, y: p.y, width: p.width - first, height: p.height }];
    }
    const first = Math.ceil(p.height / 2);
    return [{ ...p, height: first }, { id: newId, x: p.x, y: p.y + first, width: p.width, height: p.height - first }];
  });
}
