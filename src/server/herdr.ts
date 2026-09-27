// Presence from herdr: which harness runs in which pane, under which session, and whether it
// is working. herdr is optional — without it tasks simply have no presence and cannot be
// brought to the front. It is never used to deliver replies.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HARNESSES, type Harness, type Presence } from "../shared/types.ts";
import type { PresenceSource } from "./inbox.ts";

const run = promisify(execFile);
const POLL_MS = 3000;

interface HerdrAgent {
  agent?: string;
  agent_session?: { value?: string };
  agent_status?: Presence["status"];
  cwd?: string;
  name?: string;
  pane_id: string;
  terminal_title_stripped?: string;
}

export class Herdr implements PresenceSource {
  private agents: HerdrAgent[] = [];
  private ok = false;
  private timer: NodeJS.Timeout | null = null;
  private bin: string;
  onChange: () => void = () => {};

  constructor(bin = process.env.HERDR_BIN_PATH ?? "herdr") {
    this.bin = bin;
  }

  start(): void {
    const tick = async () => {
      await this.refresh();
      this.timer = setTimeout(tick, POLL_MS);
      this.timer.unref();
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async refresh(): Promise<void> {
    let next: HerdrAgent[] = [];
    let ok = false;
    try {
      const { stdout } = await run(this.bin, ["agent", "list"], { timeout: 2500 });
      next = (JSON.parse(stdout) as { result?: { agents?: HerdrAgent[] } }).result?.agents ?? [];
      ok = true;
    } catch {
      // herdr not installed or not running: no presence, which is a valid state.
    }
    const before = JSON.stringify([this.ok, this.agents.map(fingerprint)]);
    this.agents = next;
    this.ok = ok;
    if (JSON.stringify([ok, next.map(fingerprint)]) !== before) this.onChange();
  }

  available(): boolean {
    return this.ok;
  }

  forSession(harness: Harness, sessionId: string): Presence | null {
    const a = this.agents.find((x) => x.agent === harness && x.agent_session?.value === sessionId);
    return a ? toPresence(a) : null;
  }

  resolvePane(paneId: string): { harness: Harness; sessionId: string; cwd: string | null } | null {
    const a = this.agents.find((x) => x.pane_id === paneId);
    const harness = a?.agent as Harness | undefined;
    const sessionId = a?.agent_session?.value;
    if (!a || !harness || !HARNESSES.includes(harness) || !sessionId) return null;
    return { harness, sessionId, cwd: a.cwd ?? null };
  }

  /** Brings the pane to the front in herdr. */
  async focus(paneId: string): Promise<void> {
    await run(this.bin, ["agent", "focus", paneId], { timeout: 2500 });
  }
}

function fingerprint(a: HerdrAgent): string {
  return `${a.pane_id}|${a.agent}|${a.agent_session?.value}|${a.agent_status}|${a.name}`;
}

function toPresence(a: HerdrAgent): Presence {
  return {
    source: "herdr",
    paneId: a.pane_id,
    status: a.agent_status ?? "unknown",
    name: a.name ?? null,
    title: a.terminal_title_stripped ?? null,
    seenAt: new Date().toISOString(),
  };
}
