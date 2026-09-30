// `inbox pane`: opens a pane in the caller's herdr tab and prints its id. Where it goes is
// `nextSplit`'s decision, so a lead's crew end up in a grid rather than a stack.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nextSplit, type PaneRect } from "../shared/panes.ts";

const run = promisify(execFile);

interface Layout {
  panes: Array<{ pane_id: string; rect: { x: number; y: number; width: number; height: number } }>;
}

/** herdr's answer, or an error carrying herdr's own message. */
async function herdr<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await run(process.env.HERDR_BIN_PATH ?? "herdr", args, { timeout: 20_000 });
    return (JSON.parse(stdout) as { result: T }).result;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    for (const out of [e.stdout, e.stderr]) {
      let message: string | undefined;
      try {
        message = (JSON.parse(out ?? "") as { error?: { message?: string } }).error?.message;
      } catch {
        // not JSON: try the next stream
      }
      if (message) throw new Error(`herdr: ${message}`);
    }
    throw new Error(`herdr did not answer: ${(e.message ?? "").split("\n")[0]}`);
  }
}

/** Splits the pane `nextSplit` picks in the caller's tab, without taking focus, and returns the new pane's id. */
export async function openPane(cwd: string): Promise<string> {
  if (!process.env.HERDR_PANE_ID) throw new Error("inbox pane must run inside a herdr pane");
  const { layout } = await herdr<{ layout: Layout }>(["pane", "layout", "--pane", process.env.HERDR_PANE_ID]);
  const panes: PaneRect[] = layout.panes.map((p) => ({ id: p.pane_id, ...p.rect }));
  const { pane, direction } = nextSplit(panes);
  const { pane: created } = await herdr<{ pane: { pane_id: string } }>(["pane", "split", pane, "--direction", direction, "--ratio", "0.5", "--cwd", cwd, "--no-focus"]);
  return created.pane_id;
}
