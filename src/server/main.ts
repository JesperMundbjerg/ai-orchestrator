// Starts the inbox service: SQLite in the data directory, herdr presence, the office world, the
// watch on headless browsers left running, and the HTTP surface on loopback.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIXED } from "../shared/crewtree.ts";
import { dataDir, openDatabase } from "./db.ts";
import { Herdr } from "./herdr.ts";
import { createInboxServer } from "./http.ts";
import { StandingLanes } from "./standing.ts";
import { CrewTreeStore } from "./crewtree.ts";
import { Inbox } from "./inbox.ts";
import { Leases } from "./leases.ts";
import { AutoApprove } from "./autoapprove.ts";
import { Machine } from "./machine.ts";
import { StallWatch } from "./stallwatch.ts";
import { Switches } from "./switch.ts";
import { LaneRouting, piPaused } from "./lanerouting.ts";
import { startIntegrations, startupConfig } from "./startup-config.ts";
import { Usage } from "./usage.ts";
import { World } from "./world.ts";
import { PageComments } from "./pagecomments.ts";

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
// Standing lanes whose project declares an attach command: checked when read, recovered only when you ask.
const standing = new StandingLanes(() => world.state(), herdr);
world.messages.laneRegistration = standing.registered;
world.standingHolds = standing.holding;
const switches = new Switches(db, world, herdr, dir);
// A project that declares a lane-routing override gets its standing lanes' harness written there: by the founder's switch, and by the Pi pause.
const laneRouting = new LaneRouting(db, {
  notice: (title, body, agentIds) => { world.messages.founderNotices.record(title, body, agentIds, Date.now()); world.onChange("world"); },
  tree: () => world.crew?.state().tree ?? null,
  registered: standing.registered,
});
switches.tookOver = (agentId, to, model) => laneRouting.switched(world.state(), agentId, to, model);
const syncLaneRouting = () => {
  try { laneRouting.sync(world.state(), piPaused(world.crew?.state().tree.mode, usage.crewPause())); } catch (err) { console.error(`lane routing: ${(err as Error).message}`); }
};
// The capture lease: one headless checker per repository, passed on FIFO and told through ordinary office notices.
const leases = new Leases(db, {
  state: () => world.state(),
  notify: (agentId, text) => void world.messages.notice(agentId, text),
  presence: () => herdr.available(),
  telemetry: world.pipelines.telemetry,
});
// Blocks of the event loop over a second, with a CPU profile of each; INBOX_STALL_WATCH=0 turns it off.
const stalls = process.env.INBOX_STALL_WATCH === "0" ? undefined : new StallWatch({ dir: join(dir, "stalls") });
void stalls?.start().catch((err: Error) => console.error(`stall watch: ${err.message}`));
// When disabled there is no process watcher or process-control HTTP surface at all.
const machine = config.browserCleanup ? new Machine(() => world.state()) : undefined;
if (machine) machine.tellLead = (teamId, text) => world.tellLead(teamId, text);
// Comments from web pages go to a team by id as ordinary founder messages; hosting pages are the founder's setting.
const pageComments = new PageComments(db, {
  state: () => world.state(),
  instruct: (teamId, input) => world.messages.instruct(teamId, input),
  message: (id) => world.messages.message(id),
  resolve: (session) => world.resolve({ ...session, cwd: session.cwd ?? undefined }),
}, join(dir, "page-comments.json"));
const dist = fileURLToPath(new URL("../../dist", import.meta.url));

startIntegrations(config, { herdr, machine, usage });
void switches.resume();
syncLaneRouting();
setInterval(() => {
  inbox.wakeDue();
  try {
    if (usage.tellFounder(world.messages.founderNotices, world.crew?.state().tree.mode === MIXED)) world.onChange("usage");
  } catch (err) {
    console.error(`usage: ${(err as Error).message}`);
  }
  syncLaneRouting();
  try { leases.sweep(); } catch (err) { console.error(`capture leases: ${(err as Error).message}`); }
  try { pageComments.sync(); } catch (err) { console.error(`page comments: ${(err as Error).message}`); }
  try { world.waivers.sync(); } catch (err) { console.error(`waivers: ${(err as Error).message}`); }
  void world.react().catch((err: Error) => console.error(`office: ${err.message}`));
}, 30_000).unref();

createInboxServer(inbox, herdr, { port, staticDir: existsSync(dist) ? dist : null, world, machine, stalls, switches, usage, autoApprove, standing, leases, pageComments }).listen(port, "127.0.0.1", () => {
  autoApprove.sweep();
  console.log(`Review inbox on http://localhost:${port}  (data: ${dir})`);
});
