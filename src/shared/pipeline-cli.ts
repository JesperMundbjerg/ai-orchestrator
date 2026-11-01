// The office CLI by absolute path, for every instruction text the office writes. A cold agent's
// pane need not have `inbox` on its PATH, so a text that says "run inbox pipeline …" strands it.
// Node-only: never import this from src/ui.
import { fileURLToPath } from "node:url";

/** The CLI of the checkout the service runs from; the same file the first-mate brief names. */
export const INBOX_BIN = fileURLToPath(new URL("../../bin/inbox", import.meta.url));
const shellPath = /^[\w@%+=:,./-]+$/.test(INBOX_BIN) ? INBOX_BIN : `'${INBOX_BIN.replaceAll("'", `'\\''`)}'`;
/** A runnable command line: `inboxCommand("pipeline status")`. `rest` is written as it should read, placeholders included. */
export const inboxCommand = (rest: string): string => `${shellPath} ${rest}`;
