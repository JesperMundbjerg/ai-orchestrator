// Isolated browser-test service. Never connects to herdr or touches the user's data.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, dataDir } from "../../src/server/db.ts";
import { Inbox } from "../../src/server/inbox.ts";
import { createInboxServer } from "../../src/server/http.ts";
import { World, type AgentSource } from "../../src/server/world.ts";

const db = openDatabase(join(dataDir(), "inbox.sqlite"));
const unused = async () => { throw new Error("not allowed in scratch office"); };
const source: AgentSource = {
  available: () => true,
  live: () => [{ paneId: "scratch-heron", harness: "manual", sessionId: "scratch", cwd: null, status: "done", title: null, name: "heron" }],
  prompt: unused, notify: async (title, body) => { console.log(JSON.stringify({ title, body })); },
  createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused,
};
const inbox = new Inbox(db, join(dataDir(), "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
const world = new World(db, source, () => inbox.state());
const agent = world.state().agents[0]!;
world.updateAgent(agent.id, { name: "Heron" });
const team = await world.createTeam({ name: "Review Inbox", standing: true });
world.updateAgent(agent.id, { teamId: team.id, role: "lead" });
const queue = world.messages.tell(agent.id, { text: "Check the delivery path." });
world.messages.tell(agent.id, { text: "Also check the queued-message count." });
db.prepare("UPDATE message_deliveries SET updated_at = ? WHERE message_id = ?").run(new Date(Date.now() - 12 * 60_000).toISOString(), queue.id);
// An in-flight prompt prevents the regular sender claiming the queued one; the watchdog only observes.
const sending = world.messages.tell(agent.id, { text: "An earlier prompt is still being typed." });
db.prepare("UPDATE message_deliveries SET state = 'sending' WHERE message_id = ?").run(sending.id);
await world.react();
world.messages.say(world.state().agents[0]!, { to: "founder", text: "The transport check is ready; the office notice above flags the stuck queue." });
createInboxServer(inbox, null, { port: Number(process.env.INBOX_PORT), staticDir: fileURLToPath(new URL("../../dist", import.meta.url)), world })
  .listen(Number(process.env.INBOX_PORT), "127.0.0.1");
