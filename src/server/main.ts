// Starts the inbox service: SQLite in the data directory, herdr presence, the office world, the
// watch on headless browsers left running, and the HTTP surface on loopback.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIXED } from "../shared/crewtree.ts";
import { dataDir, openDatabase } from "./db.ts";
import { Herdr } from "./herdr.ts";
import { createInboxServer } from "./http.ts";
import { CrewTreeStore } from "./crewtree.ts";
import { Inbox } from "./inbox.ts";
import { AutoApprove } from "./autoapprove.ts";
import { Machine } from "./machine.ts";
import { Switches } from "./switch.ts";
import { startIntegrations, startupConfig } from "./startup-config.ts";
import { Usage } from "./usage.ts";
import { World } from "./world.ts";

export const DEFAULT_PORT = 4870;

const config = startupConfig();
const port = Number(process.env.INBOX_PORT ?? DEFAULT_PORT);
const dir = dataDir();
const herdr = new Herdr();
const db = openDatabase(join(dir, "inbox.sqlite"));
const inbox = new Inbox(db, join(dir, "files"), herdr);
const autoApprove = new AutoApprove(db, inbox);
const world = new World(db, herdr, () => inbox.state());
world.crew = new CrewTreeStore(dir);
world.crew.seed();
// The plan's limits and each agent's use; near Claude's 5-hour limit the crew guide gives Pi under Mix, and near Codex's limits Claude.
const usage = new Usage(db);
world.usage = usage;
world.crew.pause = () => usage.crewPause();
world.messages.replies = inbox;
// A team with no lead online that others wait on is put to the founder as one inbox decision.
world.leadWatch.inbox = inbox;
// Exact-SHA repair waivers are put to the founder as inbox decisions, and only their own choice grants one.
world.waivers.inbox = inbox;
world.messages.uploads = inbox.uploads;
herdr.queuedPanes = () => world.messages.queuedPanes(world.state());
inbox.presentationPath = (session) => {
  try {
    const agent = world.resolve({ ...session, cwd: session.cwd ?? undefined });
    const team = world.state().teams.find((t) => t.id === agent.teamId);
    return team ? (team.standing ? null : team.path) : session.cwd;
  } catch { return session.cwd; }
};
const switches = new Switches(db, world, herdr, dir);
// When disabled there is no process watcher or process-control HTTP surface at all.
const machine = config.browserCleanup ? new Machine(() => world.state()) : undefined;
if (machine) machine.tellLead = (teamId, text) => world.tellLead(teamId, text);
const dist = fileURLToPath(new URL("../../dist", import.meta.url));

startIntegrations(config, { herdr, machine, usage });
void switches.resume();
setInterval(() => {
  inbox.wakeDue();
  try {
    if (usage.tellFounder(world.messages.founderNotices, world.crew?.state().tree.mode === MIXED)) world.onChange("usage");
  } catch (err) {
    console.error(`usage: ${(err as Error).message}`);
  }
  try { world.waivers.sync(); } catch (err) { console.error(`waivers: ${(err as Error).message}`); }
  void world.react().catch((err: Error) => console.error(`office: ${err.message}`));
}, 30_000).unref();

createInboxServer(inbox, herdr, { port, staticDir: existsSync(dist) ? dist : null, world, machine, switches, usage, autoApprove }).listen(port, "127.0.0.1", () => {
  autoApprove.sweep();
  console.log(`Review inbox on http://localhost:${port}  (data: ${dir})`);
});
