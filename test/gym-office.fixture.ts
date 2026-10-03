// Scratch-only office for the gym's browser check: the real HTTP service and UI, with a fake world of idle agents
// on one standing team and nothing read from herdr, sessions or accounts. Run only through scripts/lib/scratch-office.ts.
// GYM_AGENTS sets how many idle agents there are. Writing "working" to $GYM_CONTROL puts them all to work, so the check
// sees them leave; "idle" sends them back.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import type { WorldAgent } from "../src/shared/types.ts";

// The launcher has checked the environment is isolated; HOME here is already the scratch one.
const port = Number(process.env.INBOX_PORT);
const home = process.env.HOME!;
const names = ["Ada", "Bo", "Clara", "Dara", "Eli", "Finn", "Gia", "Hugo", "Iris", "Jude", "Kai", "Lena", "Milo", "Nora", "Otto"];
const teams = [{ id: "studio", name: "Gym check", purpose: "", standing: true, path: null, worktrees: [], branch: null, handsTo: null, createdAt: "", status: "idle", blockedBy: [] }];
const agents: WorldAgent[] = Array.from({ length: Number(process.env.GYM_AGENTS ?? 23) }, (_, i) => ({
  id: `idle-${i}`, identity: `idle-${i}`, name: names[i] ?? `Guest ${i}`, harness: "manual", cwd: null, project: null, branch: null, status: "idle",
  title: null, paneId: null, taskIds: [], teamId: "studio", role: i ? "member" : "lead", waitingOnYou: false, doing: null, helpers: [], model: null,
  sessionName: null, ran: true,
}));
const state = { teams, agents, messages: [], withFounder: [], work: [], repositories: [], herdr: "unavailable" };
// The server sets onChange to its broadcast.
const world = { state: () => state, react: async () => {}, onChange: (_reason: string) => {} };
mkdirSync(process.env.INBOX_DATA_DIR!, { recursive: true });
const db = openDatabase(join(process.env.INBOX_DATA_DIR!, "inbox.sqlite"));
const inbox = new Inbox(db, join(home, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
const server = createInboxServer(inbox, null, { port, staticDir: resolve("dist"), world } as never);
server.listen(port, "127.0.0.1");

let shown = "idle";
setInterval(() => {
  const control = process.env.GYM_CONTROL;
  const want = control && existsSync(control) ? readFileSync(control, "utf8").trim() : "idle";
  if (want === shown || (want !== "idle" && want !== "working")) return;
  shown = want;
  for (const a of agents) a.status = want as WorldAgent["status"];
  world.onChange("world");
}, 200);
