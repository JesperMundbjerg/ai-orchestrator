// Page comments: the founder comments from a web page to a team the office knows. The office owns
// team addressing — pages pick a team by id from the list here, never by name — and a comment is an
// ordinary founder instruction through Messages.instruct, so it queues, batches, dedupes and shows
// like any other. Which page origins may host the widget is the founder's setting, kept in the data
// directory; it governs postMessage and framing only, never the service's Origin guard.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { object, optional, list, text, nonempty, record, type Schema } from "../shared/agent-protocol.ts";
import {
  DEFAULT_PAGE_ORIGINS, normalizeOriginPattern, pageCommentText, cleanPageContext,
  type PageCommentInput, type PageCommentResult, type PageTeam,
} from "../shared/pagecomments.ts";
import type { Message, WorldState } from "../shared/types.ts";
import { InboxError } from "./inbox.ts";

export const pageCommentSchema: Schema<PageCommentInput> = object({
  text: optional(text), page: optional(record), images: optional(list(nonempty)), clientId: optional(nonempty),
});
export const pageOriginsSchema = object({ origins: list(text) });

interface Office {
  state(): WorldState;
  instruct(teamId: string, input: { text?: string; images?: string[]; clientId?: string }): Message;
}

export class PageComments {
  private office: Office;
  private settingsPath: string;

  constructor(office: Office, settingsPath: string) {
    this.office = office;
    this.settingsPath = settingsPath;
  }

  /** Every team, ordered by name, with only what a page needs to pick one. */
  teams(): { teams: PageTeam[] } {
    const state = this.office.state();
    const teams = state.teams.map((t): PageTeam => {
      const lead = state.agents.find((a) => a.teamId === t.id && a.role === "lead") ?? null;
      const online = !!lead && lead.status !== "offline";
      return {
        id: t.id, name: t.name, purpose: t.purpose, status: t.status,
        lead: lead ? { name: lead.name, online } : null, leadPresent: online,
      };
    });
    return { teams: teams.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** One founder message to the team's lead, the page context rendered at its top. */
  send(teamId: string, input: PageCommentInput): PageCommentResult {
    const page = cleanPageContext(input.page);
    const body = input.text?.trim() ?? "";
    if (!body && !input.images?.length) throw new InboxError(400, "the comment needs some text");
    const message = this.office.instruct(teamId, { text: pageCommentText(body, page), images: input.images, clientId: input.clientId });
    const team = this.office.state().teams.find((t) => t.id === message.teamId);
    return { messageId: message.id, teamId: message.teamId!, teamName: team?.name ?? "", createdAt: message.createdAt };
  }

  /** The page origins allowed to host the widget; local dev servers until the founder sets them. */
  origins(): { origins: string[]; default: boolean } {
    if (!existsSync(this.settingsPath)) return { origins: [...DEFAULT_PAGE_ORIGINS], default: true };
    try {
      const saved = JSON.parse(readFileSync(this.settingsPath, "utf8")) as { origins?: unknown };
      if (!Array.isArray(saved.origins)) throw new Error("no origins");
      return { origins: saved.origins.map(String).map(normalizeOriginPattern).filter((o): o is string => !!o), default: false };
    } catch {
      // A damaged file fails closed: no page may host the widget until the founder saves the list again.
      return { origins: [], default: false };
    }
  }

  setOrigins(input: { origins: string[] }): { origins: string[]; default: boolean } {
    const out: string[] = [];
    for (const raw of input.origins) {
      const o = normalizeOriginPattern(raw);
      if (!o) throw new InboxError(400, `not a page origin: ${raw.slice(0, 80)} (use scheme://host, scheme://host:port or scheme://host:*)`);
      if (!out.includes(o)) out.push(o);
    }
    if (out.length > 50) throw new InboxError(400, "allow at most 50 page origins");
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const tmp = `${this.settingsPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ origins: out }, null, 2)}\n`);
    renameSync(tmp, this.settingsPath);
    return { origins: out, default: false };
  }

  /** Framing headers for the widget: only allowed page origins may frame it. */
  embedHeaders(): Record<string, string> {
    const { origins } = this.origins();
    return {
      "content-security-policy": `frame-ancestors 'self'${origins.length ? ` ${origins.join(" ")}` : ""}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-cache",
    };
  }
}
