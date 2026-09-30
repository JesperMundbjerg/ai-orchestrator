// `inbox` — the agent protocol from any shell. An agent in any harness can submit review
// items, report activity and collect replies; the session is identified from the harness's
// environment (or the herdr pane) so no setup is needed per conversation.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { acknowledge, call, fetchReplies, formatReply } from "../shared/agent-client.ts";
import { lengthHints, SOFT_CAPS } from "../shared/decision.ts";
import { parsePage } from "../shared/pages.ts";
import { projectRoot } from "../shared/project.ts";
import type { EvidenceInput, Item, ItemType, Message, Page, SessionInput, SubmitInput, SubmitResult, TeamBrief, Work } from "../shared/types.ts";

const HELP = `inbox — send review items to the Review Inbox and collect the answers

  inbox decide  "The question?" --request "…" --option "Label: consequence" --option "…" --recommend "…"
  inbox try     "Title" --preview URL [--check "what to do and expect"] [--viewport phone] [--setup "…"]
  inbox try     "Title" --page "Label=URL" [--look "what to look at"] --page … [--check "…"]
  inbox milestone "Title" [--context "what changed"] [--limitations "…"]
      common: --request "what you need"  --context "…"  --screenshot FILE (repeat)  --url URL (repeat)
              --key KEY (resubmitting a key revises that item)  --task "task name"  --nonblocking | --blocking
              --json FILE|-   (a full SubmitInput item; flags override)

  Write a decision the way an engineer asks a colleague: the title is the question, the request
  says what you need and what happens if nobody answers, the context holds only what matters for
  choosing, and the recommendation is your pick and why. For example:

    inbox decide "Should the tutor cover the slider or push it aside?" \\
      --request "I need this to finish the isotope step. Until you answer I'll keep it docked." \\
      --context "On a laptop the overlay hides the slider students are told to drag." \\
      --option "Overlay: tutor covers the right third; slider hidden while it talks" \\
      --option "Docked: the stage narrows; everything stays visible" \\
      --recommend "Docked, because the lesson depends on the slider staying in view"

  To show what you did in the app itself, line up the pages to go through in order: the founder
  sees each one live in a frame and presses Next. --page works on decide and milestone too.
  Use http://localhost:…: dev servers such as Next only answer on localhost, not 127.0.0.1.

    inbox try "Isotope simulation: new drag hint" \\
      --page "Step 1=http://localhost:3000/sim/isotopes?step=1" --look "The hint pulses under the slider" \\
      --page "Step 2=http://localhost:3000/sim/isotopes?step=2" --look "It is gone once you have dragged"

  A try answers as "Approved" (done, maybe with a note) or "Needs changes" (the note says what); a milestone as accepted or changes requested.

  Keep the title near ${SOFT_CAPS.title} characters and the request near ${SOFT_CAPS.request}; longer is accepted with a hint.

  inbox activity "what you are doing now" [--next "next milestone"]
  inbox replies [--ack]          print answers waiting for this session
  inbox ack DELIVERY_ID           confirm you have received an answer
  inbox withdraw KEY | inbox resolve KEY
  inbox hook claude               Claude Code hook (Stop / UserPromptSubmit / SessionStart)

  The office (a project per worktree, run by its first mate; standing teams like Mission Control):
  inbox team                      who you are, your project, your part in it, what waits for you
  inbox say NAME "text"           message an agent, project, team or a project's lane by name; it arrives when they are free
  inbox say founder "text"        answer the founder in a sentence or two; shown beside you in the office
  inbox handoff "Title" --summary "what was done, where, how to check it" [--to TEAM]
  inbox handoff --work ID --summary "what changed"      hand it over again after changes
  inbox review ID accept|changes --notes "…"            your team's verdict on work handed to it

The session comes from CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or HERDR_PANE_ID, or --harness/--session.
The service is INBOX_URL (default http://127.0.0.1:4870).`;

const OPTIONS = {
  option: { type: "string", multiple: true },
  recommend: { type: "string" },
  request: { type: "string" },
  context: { type: "string" },
  limitations: { type: "string" },
  check: { type: "string" },
  preview: { type: "string" },
  page: { type: "string", multiple: true },
  look: { type: "string", multiple: true },
  viewport: { type: "string" },
  setup: { type: "string" },
  screenshot: { type: "string", multiple: true },
  url: { type: "string", multiple: true },
  key: { type: "string" },
  task: { type: "string" },
  blocking: { type: "boolean" },
  nonblocking: { type: "boolean" },
  json: { type: "string" },
  next: { type: "string" },
  summary: { type: "string" },
  to: { type: "string" },
  work: { type: "string" },
  notes: { type: "string" },
  ack: { type: "boolean" },
  harness: { type: "string" },
  session: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<typeof parseArgs<{ allowPositionals: true; options: typeof OPTIONS }>>["values"];
let flags: Flags = {};
/** The flags in the order given, so each --look belongs to the --page before it. */
let order: Array<{ name: string; value: string | undefined }> = [];

function session(): SessionInput {
  const cwd = process.cwd();
  if (flags.harness && flags.session) return { harness: flags.harness as SessionInput["harness"], sessionId: flags.session, cwd };
  if (process.env.CLAUDE_CODE_SESSION_ID) return { harness: "claude", sessionId: process.env.CLAUDE_CODE_SESSION_ID, cwd };
  if (process.env.CODEX_THREAD_ID) return { harness: "codex", sessionId: process.env.CODEX_THREAD_ID, cwd };
  if (process.env.HERDR_PANE_ID) return { paneId: process.env.HERDR_PANE_ID, cwd };
  throw new Error("cannot tell which agent session this is: run inside Claude Code, Codex or a herdr pane, or pass --harness and --session");
}

async function submit(type: ItemType, title: string | undefined): Promise<void> {
  const base = flags.json ? (JSON.parse(readFileSync(flags.json === "-" ? 0 : flags.json, "utf8")) as Partial<SubmitInput["item"]>) : {};
  const itemTitle = title ?? base.title;
  if (!itemTitle) throw new Error(`inbox ${type} needs a title`);
  const evidence: EvidenceInput[] = [
    ...(base.evidence ?? []),
    ...(flags.screenshot ?? []).map((p) => ({ path: resolve(p) })),
    ...(flags.url ?? []).map((url) => ({ url })),
  ];
  const context = [flags.context ?? base.context, flags.limitations && `Known limitations: ${flags.limitations}`].filter(Boolean).join("\n\n");
  const item: SubmitInput["item"] = {
    ...base,
    type,
    title: itemTitle,
    key: flags.key ?? base.key,
    request: flags.request ?? base.request,
    context: context || undefined,
    recommendation: flags.recommend ?? base.recommendation,
    options: flags.option ?? base.options,
    check: flags.check ?? base.check,
    preview: flags.preview || ((flags.viewport || flags.setup) && flags.page)
      ? { url: flags.preview, viewport: (flags.viewport as "phone" | "desktop" | undefined) ?? null, setup: flags.setup ?? "" }
      : base.preview,
    pages: flags.page ? pagesFrom(order) : base.pages,
    blocking: flags.blocking ? true : flags.nonblocking ? false : base.blocking,
    evidence,
  };
  const s = session();
  const result = await call<SubmitResult>("/api/agent/items", {
    session: s,
    project: projectRoot(s.cwd ?? process.cwd()),
    task: flags.task ? { title: flags.task } : undefined,
    item,
  });
  for (const hint of lengthHints(item)) console.error(`inbox: hint: ${hint}`);
  console.log(result.changed ? `Submitted "${itemTitle}" (revision ${result.revision}, item ${result.itemId}).` : `No change: "${itemTitle}" is already in the inbox as revision ${result.revision}.`);
}

/** --page "Label=URL" [--look "…"], repeated: each --look says what to look at on the page before it. */
export function pagesFrom(given: Array<{ name: string; value: string | undefined }>): Array<Partial<Page>> {
  const pages: Array<Partial<Page>> = [];
  for (const { name, value } of given) {
    if (name === "page" && value !== undefined) pages.push(parsePage(value));
    if (name === "look") {
      const last = pages.at(-1);
      if (!last) throw new Error('--look says what to look at on the page before it: --page "Label=URL" --look "…"');
      last.look = value;
    }
  }
  return pages;
}

async function replies(): Promise<void> {
  const s = session();
  const pending = await fetchReplies(s, "pull");
  if (!pending.length) return console.log("No replies waiting.");
  for (const r of pending) {
    console.log(formatReply(r));
    if (flags.ack) await acknowledge(s, r.deliveryId);
    else console.log(`(Confirm receipt: inbox ack ${r.deliveryId})`);
    console.log("");
  }
}

/** Claude Code hook: hands queued replies to the session at its turn boundaries, and tells the office a new session's model. */
async function claudeHook(): Promise<void> {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}") as { hook_event_name?: string; session_id?: string; cwd?: string };
  if (!input.session_id) return;
  const s: SessionInput = { harness: "claude", sessionId: input.session_id, cwd: input.cwd };
  // A starting session says which model it runs; the office hears it as it hears the HTTP hooks.
  if (input.hook_event_name === "SessionStart") await call("/api/hooks/claude", input, 1500).catch(() => {});
  let pending;
  try {
    pending = await fetchReplies(s, "boundary");
  } catch {
    return; // the inbox is not running or does not know this session: stay out of the way
  }
  if (!pending.length) return;
  const text = pending.map(formatReply).join("\n\n---\n\n");
  const event = input.hook_event_name;
  if (event === "Stop") process.stdout.write(JSON.stringify({ decision: "block", reason: text }));
  else if (event === "UserPromptSubmit" || event === "SessionStart") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  } else return;
  for (const r of pending) await acknowledge(s, r.deliveryId).catch(() => {});
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, tokens: true });
  flags = parsed.values;
  order = parsed.tokens.flatMap((t) => (t.kind === "option" ? [{ name: t.name, value: t.value }] : []));
  const [command, arg] = parsed.positionals;
  if (!command || flags.help) return console.log(HELP);
  switch (command) {
    case "decide":
    case "try":
    case "milestone":
      return submit(command, arg);
    case "activity": {
      await call("/api/agent/activity", { session: session(), activity: arg, nextMilestone: flags.next });
      return console.log("Activity updated.");
    }
    case "replies":
      return replies();
    case "ack":
      if (!arg) throw new Error("inbox ack needs a delivery id");
      await acknowledge(session(), arg);
      return console.log("Acknowledged.");
    case "withdraw":
    case "resolve": {
      if (!arg) throw new Error(`inbox ${command} needs an item key or id`);
      const item = await call<Item>(`/api/agent/${command}`, { session: session(), item: arg });
      return console.log(`"${item.title}" is ${item.state}.`);
    }
    case "team":
      return console.log((await call<TeamBrief>("/api/agent/team", { session: session() })).text);
    case "say": {
      const [, to, text] = parsed.positionals;
      if (!to || !text) throw new Error('inbox say needs a name and the text: inbox say NAME "text"');
      const message = await call<Message>("/api/agent/say", { session: session(), to, text, clientId: randomUUID() });
      if (message.toFounder) return console.log("Said to the founder: it shows in your panel in the office.");
      return console.log(`Sent to ${to}: it is typed into their terminal once they are free (${message.deliveries.length} ${message.deliveries.length === 1 ? "agent" : "agents"}).`);
    }
    case "handoff": {
      const { work } = await call<{ work: Work }>("/api/agent/handoff", { session: session(), title: arg, summary: flags.summary, to: flags.to, work: flags.work, clientId: randomUUID() });
      return console.log(`Handed over as work ${work.id} (round ${work.round}). The verdict arrives as a message; \`inbox team\` shows where it stands.`);
    }
    case "review": {
      const verdict = parsed.positionals[2];
      if (!arg || !verdict) throw new Error('inbox review needs the work id and a verdict: inbox review ID accept|changes --notes "…"');
      const { work } = await call<{ work: Work }>("/api/agent/review", { session: session(), work: arg, verdict, notes: flags.notes });
      return console.log(`Work ${work.id} is ${work.state === "accepted" ? "accepted" : "sent back with your notes"}; whoever handed it over is told.`);
    }
    case "hook":
      if (arg !== "claude") throw new Error("supported hooks: claude");
      return claudeHook();
    default:
      throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
}

export function run(argv = process.argv.slice(2)): void {
  main(argv).catch((err: Error) => {
    console.error(`inbox: ${err.message}`);
    process.exit(1);
  });
}
