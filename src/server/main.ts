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
import { QaAgents } from "./qa-agent.ts";
import { Machine } from "./machine.ts";
import { Switches } from "./switch.ts";
import { LaneRouting, piPaused } from "./lanerouting.ts";
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
// QA answers keep the QA agent's learnings in the data directory, an Open Knowledge Format bundle it writes itself.
const autoApprove = new AutoApprove(db, inbox, join(dir, "learnings"));
const world = new World(db, herdr, () => inbox.state());
const qaAgent = (a: { id: string; name: string; status: string; taskIds: string[] }) => ({ id: a.id, name: a.name, online: a.status !== "offline", taskIds: a.taskIds });
autoApprove.qa.office = {
  agent: (id) => { const found = world.state().agents.find((a) => a.id === id); return found ? qaAgent(found) : null; },
  resolve: (session) => qaAgent(world.resolve(session)),
  notice: (agentId, text) => void world.messages.notice(agentId, text),
};
world.crew = new CrewTreeStore(dir);
world.crew.seed();
// The founder picks the QA agent's model; the office starts it in herdr, like a project's lead, and designates it.
const crew = world.crew;
autoApprove.agents = new QaAgents(db, herdr, { catalog: () => crew.catalog(), learnings: autoApprove.qa.learnings });
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
// When disabled there is no process watcher or process-control HTTP surface at all.
const machine = config.browserCleanup ? new Machine(() => world.state()) : undefined;
if (machine) machine.tellLead = (teamId, text) => world.tellLead(teamId, text);
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
  try { world.waivers.sync(); } catch (err) { console.error(`waivers: ${(err as Error).message}`); }
  void world.react().catch((err: Error) => console.error(`office: ${err.message}`));
}, 30_000).unref();

createInboxServer(inbox, herdr, { port, staticDir: existsSync(dist) ? dist : null, world, machine, switches, usage, autoApprove, standing, leases }).listen(port, "127.0.0.1", () => {
  autoApprove.sweep();
  console.log(`Review inbox on http://localhost:${port}  (data: ${dir})`);
});
