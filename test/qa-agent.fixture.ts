// Scratch-only office for the QA browser tests: the real service, with herdr's pane and agent operations faked in this
// process so the office can "start" a QA agent without starting anything. Run only through scripts/lib/scratch-office.ts
// (herdr's own paths stay disabled). A Haiku start fails, as herdr does when an agent never becomes ready; closed
// panes are logged to $QA_FIXTURE_LOG. Agents started here stay idle, so the office sees them online.
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Herdr } from "../src/server/herdr.ts";
import type { Harness } from "../src/shared/types.ts";
import type { LiveAgent } from "../src/server/world.ts";

const live: LiveAgent[] = [];
const panes = new Map<string, string>();
const log = (line: string) => { if (process.env.QA_FIXTURE_LOG) appendFileSync(process.env.QA_FIXTURE_LOG, `${line}\n`); };
const fake = Herdr.prototype as unknown as Record<string, unknown>;
fake.available = () => true;
fake.live = () => live.map((a) => ({ ...a }));
fake.refresh = async () => {};
fake.prompt = async () => {};
fake.notify = async () => {};
fake.openPane = async (cwd: string, _beside: string | null, label: string) => {
  const id = `fake-${panes.size + 1}`;
  panes.set(id, cwd);
  log(`open ${id} ${cwd} ${label}`);
  return id;
};
fake.startAgent = async (paneId: string, name: string, harness: Harness, args: string[]) => {
  log(`start ${paneId} ${name} ${harness} ${args.slice(0, 4).join(" ")}`);
  // Long enough for the header to show it starting.
  await delay(1500);
  if (args.includes("haiku")) throw new Error("agent did not become ready within 30s");
  live.push({ paneId, harness, sessionId: null, cwd: panes.get(paneId) ?? null, status: "idle", title: null, name });
};
fake.closePane = async (paneId: string) => {
  log(`close ${paneId}`);
  const at = live.findIndex((a) => a.paneId === paneId);
  if (at >= 0) live.splice(at, 1);
};

await import("../src/server/main.ts");
