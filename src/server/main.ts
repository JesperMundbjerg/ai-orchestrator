// Starts the inbox service: SQLite in the data directory, herdr presence, the office world, the
// watch on headless browsers left running, and the HTTP surface on loopback.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, openDatabase } from "./db.ts";
import { Herdr } from "./herdr.ts";
import { createInboxServer } from "./http.ts";
import { Inbox } from "./inbox.ts";
import { Machine } from "./machine.ts";
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
herdr.queuedPanes = () => world.messages.queuedPanes(world.state());
inbox.presentationPath = (session) => {
  try {
    const agent = world.resolve({ ...session, cwd: session.cwd ?? undefined });
    const team = world.state().teams.find((t) => t.id === agent.teamId);
    return team ? (team.standing ? null : team.path) : session.cwd;
  } catch { return session.cwd; }
};
const machine = new Machine(() => world.state());
machine.tellLead = (teamId, text) => world.tellLead(teamId, text);
const dist = fileURLToPath(new URL("../../dist", import.meta.url));

herdr.start();
machine.start();
setInterval(() => {
  inbox.wakeDue();
  void world.react().catch((err: Error) => console.error(`office: ${err.message}`));
}, 30_000).unref();

createInboxServer(inbox, herdr, { port, staticDir: existsSync(dist) ? dist : null, world, machine }).listen(port, "127.0.0.1", () => {
  console.log(`Review inbox on http://localhost:${port}  (data: ${dir})`);
});
