// `inbox pane`: opens a pane in the caller's herdr tab and prints its id. Where it goes is
// `nextSplit`'s decision, so a lead's crew end up in a grid rather than a stack.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nextSplit, type PaneRect } from "../shared/panes.ts";
import { paneEnvArgs } from "../shared/shellpath.ts";
import { herdrError } from "../shared/herdr-error.ts";

const run = promisify(execFile);
const HERDR_TIMEOUT_MS = 20_000;

interface Layout {
  panes: Array<{ pane_id: string; rect: { x: number; y: number; width: number; height: number } }>;
}

/** herdr's answer, or an error carrying herdr's own message. */
async function herdr<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await run(process.env.HERDR_BIN_PATH ?? "herdr", args, { timeout: HERDR_TIMEOUT_MS });
    return (JSON.parse(stdout) as { result: T }).result;
  } catch (err) {
    // Never the command line: it holds paths and text, and hides how herdr actually ended.
    const message = herdrError(err, args.slice(0, 2).join(" "), HERDR_TIMEOUT_MS);
    throw new Error(message.startsWith("herdr ") ? message : `herdr: ${message}`);
  }
}

/** Splits the pane `nextSplit` picks in the caller's tab, without taking focus, and returns the new pane's id; the pane gets a working PATH (shellpath.ts). */
export async function openPane(cwd: string): Promise<string> {
  if (!process.env.HERDR_PANE_ID) throw new Error("inbox pane must run inside a herdr pane");
  const { layout } = await herdr<{ layout: Layout }>(["pane", "layout", "--pane", process.env.HERDR_PANE_ID]);
  const panes: PaneRect[] = layout.panes.map((p) => ({ id: p.pane_id, ...p.rect }));
  const { pane, direction } = nextSplit(panes);
  const { pane: created } = await herdr<{ pane: { pane_id: string } }>(["pane", "split", pane, "--direction", direction, "--ratio", "0.5", "--cwd", cwd, ...paneEnvArgs(), "--no-focus"]);
  return created.pane_id;
}
