// Isolated browser-test service: a standing team whose lead is offline while two teams wait on it.
// Never connects to herdr or touches the user's data.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, dataDir } from "../../src/server/db.ts";
import { Inbox } from "../../src/server/inbox.ts";
import { createInboxServer } from "../../src/server/http.ts";
import { World, type AgentSource, type LiveAgent } from "../../src/server/world.ts";

const db = openDatabase(join(dataDir(), "inbox.sqlite"));
const unused = async () => { throw new Error("not allowed in scratch office"); };
const agent = (name: string): LiveAgent => ({ paneId: `scratch-${name}`, harness: "manual", sessionId: name, cwd: null, status: "idle", title: null, name: name.toLowerCase() });
const live = [agent("Alma"), agent("Kai"), agent("Bo"), agent("Eli")];
const source: AgentSource = {
  available: () => true, live: () => live, prompt: unused, notify: async () => {},
  createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused,
};
const inbox = new Inbox(db, join(dataDir(), "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
const world = new World(db, source, () => inbox.state());
world.leadWatch.inbox = inbox;
for (const a of world.state().agents) world.updateAgent(a.id, { name: a.paneId!.slice(8) });
const id = (name: string) => world.state().agents.find((a) => a.name === name)!.id;
const mc = await world.createTeam({ name: "Mission Control", standing: true });
const cos = await world.createTeam({ name: "Cosmology", standing: true });
const ecg = await world.createTeam({ name: "ECG", standing: true });
world.updateAgent(id("Alma"), { teamId: mc.id, role: "lead" });
world.updateAgent(id("Kai"), { teamId: mc.id, role: "member" });
world.updateAgent(id("Bo"), { teamId: cos.id, role: "lead" });
world.updateAgent(id("Eli"), { teamId: ecg.id, role: "lead" });
live.splice(0, 1); // Alma goes offline.
const by = (name: string) => world.state().agents.find((a) => a.name === name)!;
world.messages.say(by("Bo"), { to: "Mission Control", text: "Please land the fix on dev." });
world.messages.say(by("Eli"), { to: "Mission Control", text: "Waiting for the dev fix too." });
world.messages.instruct(mc.id, { text: "mission control is idle, nothing is happening" });
db.prepare("UPDATE message_deliveries SET updated_at = ?").run(new Date(Date.now() - 52 * 60_000).toISOString());
db.prepare("UPDATE messages SET created_at = ?").run(new Date(Date.now() - 52 * 60_000).toISOString());
await world.react();
createInboxServer(inbox, null, { port: Number(process.env.INBOX_PORT), staticDir: fileURLToPath(new URL("../../dist", import.meta.url)), world })
  .listen(Number(process.env.INBOX_PORT), "127.0.0.1");
