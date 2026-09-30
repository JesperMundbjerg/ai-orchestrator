// Starts the inbox service: SQLite in the data directory, herdr presence, the office world
// and the HTTP surface on loopback.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, openDatabase } from "./db.ts";
import { Herdr } from "./herdr.ts";
import { createInboxServer } from "./http.ts";
import { Inbox } from "./inbox.ts";
import { World } from "./world.ts";

export const DEFAULT_PORT = 4870;

const port = Number(process.env.INBOX_PORT ?? DEFAULT_PORT);
const dir = dataDir();
const herdr = new Herdr();
const db = openDatabase(join(dir, "inbox.sqlite"));
const inbox = new Inbox(db, join(dir, "files"), herdr);
const world = new World(db, herdr, () => inbox.state());
world.messages.replies = inbox;
world.messages.uploads = inbox.uploads;
const dist = fileURLToPath(new URL("../../dist", import.meta.url));

herdr.start();
setInterval(() => inbox.wakeDue(), 30_000).unref();

createInboxServer(inbox, herdr, { port, staticDir: existsSync(dist) ? dist : null, world }).listen(port, "127.0.0.1", () => {
  console.log(`Review inbox on http://localhost:${port}  (data: ${dir})`);
});
