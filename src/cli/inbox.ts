// `inbox` — the agent protocol from any shell. An agent in any harness can submit review
// items, report activity and collect replies; the session is identified from the harness's
// environment (or the herdr pane) so no setup is needed per conversation.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openPane } from "./pane.ts";
import { pipelineCommand, deliveryBinding } from "./pipeline.ts";
import { installHooksCommand } from "./pipeline-hooks.ts";
import { acknowledge, call, fetchReplies, formatReply, get } from "../shared/agent-client.ts";
import { lengthHints, SOFT_CAPS } from "../shared/decision.ts";
import { parsePage } from "../shared/pages.ts";
import { projectRoot } from "../shared/project.ts";
import { QA_GUIDE } from "../shared/qa.ts";
import { storyIntro } from "../shared/story.ts";
import { changedFiles, parseWrites, strayFiles } from "../shared/surface.ts";
import type { AgentSwitch, StandingLane, EvidenceInput, FounderAnswer, Item, ItemType, Message, Page, QaNext, QaPrediction, Reply, SessionInput, SubmitInput, SubmitResult, TeamBrief, Work } from "../shared/types.ts";

const HELP = `inbox — send review items to the Review Inbox and collect the answers

  inbox decide  "The question?" --request "…" --option "Label: consequence" --option "…" --recommend "…"
  inbox decide  "The open question?" --request "…"        (no options: the founder answers in words)
  inbox try     "Title" --preview URL [--check "what to do and expect"] [--viewport phone] [--setup "…"]
  inbox try     "Title" --page "Label=URL" [--look "what to look at"] --page … [--check "…"]
  inbox milestone "Title" [--context "what changed"] [--limitations "…"]
      common: --request "what you need"  --context "…"  --screenshot FILE (repeat)  --video FILE (repeat)  --url URL (repeat)
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

  Options are optional. Give two or more when the choice is between things you can name; give none
  for an open question that needs words, such as a held question with no fixed answers. The founder
  then answers in a text box and you get "Answer: <their text>". One option is refused (that is not a
  choice), and --recommend needs options, since it picks one. Resubmit with the same --key to revise either kind.

    inbox decide "Which lesson should the demo open on?" --request "I need it to finish the landing page; until you answer I'll use the pendulum." --key comment:42

  To show what you did in the app itself, line up the pages to go through in order: the founder
  sees each one live in a frame and presses Next. --page works on decide and milestone too.
  Use http://localhost:…: dev servers such as Next only answer on localhost, not 127.0.0.1.

    inbox try "Isotope simulation: new drag hint" \\
      --page "Step 1=http://localhost:3000/sim/isotopes?step=1" --look "The hint pulses under the slider" \\
      --page "Step 2=http://localhost:3000/sim/isotopes?step=2" --look "It is gone once you have dragged"

  A try answers as "Approved" (done, maybe with a note) or "Needs changes" (the note says what); a milestone as accepted or changes requested.

  --video copies MP4, WebM or MOV files up to 200 MB each; playback depends on browser codec support.
  --screenshot copies images, PDFs, Markdown or text up to 20 MB (and also accepts videos).
  Only explicitly attached regular files are copied; never dotfiles.

  Keep the title near ${SOFT_CAPS.title} characters and the request near ${SOFT_CAPS.request}; longer is accepted with a hint.

  inbox activity "what you are doing now" [--next "next milestone"]
  inbox replies [--ack]          print answers waiting for this session
  inbox ack DELIVERY_ID           confirm you have received an answer
  inbox withdraw KEY | inbox resolve KEY
  inbox hook claude               Claude Code hook (Stop / UserPromptSubmit / SessionStart)
  inbox statusline                Claude Code statusline: tells the office the plan's 5-hour and weekly use, prints them

  The office (a project per worktree, run by its first mate; standing teams like Mission Control):
  inbox team                      who you are, your project, your part in it, what waits for you
  inbox story "…"                 save your own short personal story (plain text, capped at 800 characters)
  ${storyIntro()}
  inbox crew                      the active crew preset and guide: which harness and model to start, under the founder's switch
  inbox say NAME "text"           message an agent, project, team or a project's lane by name; it arrives when they are free
  inbox say founder "text"        answer the founder in a sentence or two; shown beside you in the office
  inbox handoff "Title" --summary "what was done, where, how to check it" [--to TEAM]
  inbox handoff --work ID --summary "what changed"      hand it over again after changes
  inbox review ID accept|changes --notes "…"            your team's verdict on work handed to it
      protected handoff/review: --run RUN [--round N --candidate SHA --node INTERNAL_REVIEW]
      milestone/try --run RUN binds the exact run candidate, not the lead's checkout
  inbox pipeline start [--base BASE --candidate SHA --checkout DIR --work ID --work-round N]
  inbox pipeline branch RUN [--select field=value (repeat)] --notes "why" [--candidate SHA]
  inbox pipeline branch RUN --base SHA [--candidate SHA] --notes "why" [--client-id ID]
  inbox pipeline abandon RUN --notes "why" [--client-id ID]
  inbox pipeline assign RUN NODE AGENT
  inbox pipeline report RUN NODE --report FILE --notes "result"
  inbox pipeline done RUN NODE [--report FILE --check "command" --exit-code 0] --notes "disposition"
      a failing check counts only as "fails as on base": first record the same command on the run's base
      with report|done ... --check "command" --exit-code N --on-base, then the candidate's run with the same N
  inbox pipeline status [RUN]
  inbox pipeline gate --operation push|pr|merge|land|publish --repo PATH --ref REF --candidate SHA --run RUN [--round N]
  inbox pipeline telemetry [RUN] [--team TEAM --kind gate|integration|publication --since ISO --limit N]
      read-only JSON: gate results (refusals too), re-base/re-pin/re-branch, publication pending/resolved, founder decision waits
  inbox pipeline waiver --repo PATH --ref dev --candidate SHA --reason "why"   ask the founder to allow exactly this commit to that branch once, without a run
      --json FILE supplies an operation payload (including structured evidence); --revision N is an optimistic lock
      --client-id ID makes a lost-response retry replay-safe. Gate is preflight, not a publication receipt.
  inbox switch NAME [--to claude|pi] [--model M] [--effort E]
                                  move an agent to the other harness: it writes a handoff, a new session takes over its
                                  name, team, role and messages, and its old pane closes; the model follows the crew guide
  inbox switch --all-from pi      the same for every running agent on that harness, one by one
  inbox lane [PROJECT LANE]       a project's standing lanes with an attach command: connected, disconnected, busy or unknown, and who holds them
  inbox lane recover PROJECT LANE --to NAME
                                  attach the lane to NAME's running session through the project's own attach command; it never
                                  renames anyone or changes a lead, and says exactly what a fresh check confirmed or why it was refused
  inbox surface-check --writes "GLOB,GLOB" --base SHA [--commit SHA]
                                  in the repository: the files changed from base to commit (default HEAD) outside a crew
                                  member's write surface; exits 1 when there are any. ** spans folders, * stays in one
  inbox pane [--cwd DIR]          open a pane in your herdr tab (a grid: 2x2 first, then it grows) and print its id: P=$(inbox pane)

  QA answers (only the agent the founder chose as QA; \`inbox qa guide\` explains the loop and the learnings):
  inbox qa next                   the next question to decide for the founder, and where the learnings are
  inbox qa answer ITEM --revision N (--choice ID | --answer "words" | --accept | --request-changes "what") --reason "why" [--learning SLUG …]
                                  in manual mode this only records your prediction of the founder's answer, never sent
  inbox qa answers [--limit N]    the founder's own answers you have not learned from yet, beside what you predicted
  inbox qa judge ITEM --revision N (--match | --mismatch)   whether your prediction in words agreed with the founder's words
  inbox qa learned --through SEQ  you have learned from those answers up to SEQ
  inbox qa guide                  how the QA agent decides and what a learning (OKF v0.2) looks like

The session comes from CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or HERDR_PANE_ID, or --harness/--session.
  --session must be the id the harness registered its session under, or the reply goes to a session nobody listens to:
    claude   the value of CLAUDE_CODE_SESSION_ID
    codex    the value of CODEX_THREAD_ID
    pi       the absolute path of the live session's .jsonl file, as herdr reports it; never the id in the file's header
  A daemon submitting for a Pi agent:  inbox --harness pi --session /Users/me/.pi/agent/sessions/--repo--/2026-09-30T10-00-00_ab12.jsonl decide "Title" --option "A" --option "B"
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
  video: { type: "string", multiple: true },
  url: { type: "string", multiple: true },
  key: { type: "string" },
  task: { type: "string" },
  blocking: { type: "boolean" },
  nonblocking: { type: "boolean" },
  json: { type: "string" },
  next: { type: "string" },
  summary: { type: "string" },
  run: { type: "string" }, base: { type: "string" }, candidate: { type: "string" }, checkout: { type: "string" },
  revision: { type: "string" }, round: { type: "string" }, select: { type: "string", multiple: true },
  report: { type: "string", multiple: true }, "exit-code": { type: "string" }, "on-base": { type: "boolean" }, "work-round": { type: "string" },
  "client-id": { type: "string" }, operation: { type: "string" }, repo: { type: "string" }, ref: { type: "string" },
  delivery: { type: "string" }, node: { type: "string" }, reason: { type: "string" }, team: { type: "string" }, kind: { type: "string" }, since: { type: "string" },
  to: { type: "string" },
  work: { type: "string" },
  cwd: { type: "string" },
  notes: { type: "string" },
  ack: { type: "boolean" },
  harness: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  "all-from": { type: "string" },
  session: { type: "string" },
  help: { type: "boolean", short: "h" },
  choice: { type: "string" }, answer: { type: "string" }, accept: { type: "boolean" }, "request-changes": { type: "string" },
  learning: { type: "string", multiple: true }, through: { type: "string" }, limit: { type: "string" },
  match: { type: "boolean" }, mismatch: { type: "boolean" },
  writes: { type: "string", multiple: true }, commit: { type: "string" },
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
    ...order.filter((f) => f.name === "screenshot" || f.name === "video").map((f) => ({
      path: resolve(f.value!), ...(f.name === "video" ? { kind: "video" as const } : {}),
    })),
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
    ...(flags.run ? { pipeline: { runId: flags.run } } : {}),
    item,
  });
  for (const hint of lengthHints(item)) console.error(`inbox: hint: ${hint}`);
  for (const warning of result.warnings ?? []) console.error(`inbox: warning: ${warning}`);
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

/**
 * `inbox switch`: asks the office to move an agent (or everyone on a harness) to the other harness,
 * then follows along, printing each step as it happens. Stopping this command does not stop the switch.
 */
async function switchAgents(name: string | undefined): Promise<void> {
  const opts = { to: flags.to, model: flags.model, effort: flags.effort };
  let ids: string[];
  if (flags["all-from"]) {
    const batch = await call<{ switches: AgentSwitch[]; skipped: Array<{ name: string; why: string }> }>("/api/world/switches/all-from", { from: flags["all-from"], ...opts });
    for (const s of batch.skipped) console.log(`${s.name}: not switched, ${s.why}.`);
    if (!batch.switches.length) throw new Error("nobody could be switched");
    console.log(`Switching ${batch.switches.map((s) => s.agentName).join(", ")} one by one.`);
    ids = batch.switches.map((s) => s.id);
  } else {
    if (!name) throw new Error("inbox switch needs the agent's name: inbox switch NAME [--to claude|pi], or --all-from HARNESS");
    const started = await call<AgentSwitch>("/api/world/switches", { agent: name, ...opts });
    console.log(`Switching ${started.agentName} to ${started.toLabel} (${started.model}, ${started.effort} effort).`);
    ids = [started.id];
  }
  const said = new Map<string, string>();
  let failed = 0;
  for (const id of ids) {
    for (;;) {
      const s = await get<AgentSwitch>(`/api/world/switches/${id}`);
      if (said.get(id) !== s.says) console.log(`${s.agentName}: ${s.says}`);
      said.set(id, s.says);
      if (s.step === "failed") failed++;
      if (s.step === "done" || s.step === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (failed) throw new Error(`${failed} of ${ids.length} not switched`);
}

/** One lane, as the founder reads it: its state, who holds it, and the last recovery. */
function laneLine(l: StandingLane): string {
  const who = l.registered ? `registered session ${l.registered.session}${l.registered.agentName ? ` (${l.registered.agentName}${l.registered.role === "lead" ? `, lead of ${l.registered.teamName}` : l.registered.teamName ? `, ${l.registered.teamName}` : ""})` : ""}` : "no registered session";
  const lines = [`${l.project}/${l.lane}: ${l.state}${l.reason ? ` — ${l.reason}` : ""}`, `  ${who}${l.companionPid ? `; companion pid ${l.companionPid}` : ""}${l.lastTurnAt ? `; last completed turn ${l.lastTurnAt}` : ""}`];
  if (l.recovery) {
    const r = l.recovery;
    const what = r.state === "attached" ? `attached at ${r.at}: a check since shows session ${r.session} connected in pane ${r.pane} with a fresh heartbeat` : r.state;
    lines.push(`  recovery onto ${r.agentName}: ${what}${r.reason ? ` — ${r.reason}` : ""}${r.log ? ` (log: ${r.log})` : ""}`);
  }
  if (l.state !== "connected") lines.push(l.candidates.length ? `  can be recovered onto: ${l.candidates.map((c) => `${c.name} (lead of ${c.teamName})`).join(", ")}` : "  no team lead runs in its checkout to recover it onto; who leads is the founder's choice");
  return lines.join("\n");
}

/** `inbox lane [PROJECT LANE]` and `inbox lane recover PROJECT LANE --to NAME`. */
async function laneCommand(args: string[]): Promise<void> {
  if (args[0] === "recover") {
    const [, project, lane] = args;
    if (!project || !lane || !flags.to) throw new Error("inbox lane recover needs the project, the lane and who to attach it to: inbox lane recover PROJECT LANE --to NAME");
    const now = await call<StandingLane>(`/api/p/${project}/lanes/${lane}/check`, {}, 30_000);
    const target = now.candidates.find((c) => c.name.toLowerCase() === flags.to!.toLowerCase());
    if (!target) throw new Error(`${flags.to} is not a team lead running in ${now.worktree}${now.candidates.length ? `; who is: ${now.candidates.map((c) => c.name).join(", ")}` : ""}`);
    const after = await call<StandingLane>(`/api/p/${project}/lanes/${lane}/recover`, { agentId: target.agentId }, 180_000);
    console.log(laneLine(after));
    if (after.recovery?.state !== "attached") process.exitCode = 1;
    return;
  }
  const [project, lane] = args;
  const lanes = project && lane ? [await call<StandingLane>(`/api/p/${project}/lanes/${lane}/check`, {}, 30_000)] : (await get<StandingLane[]>("/api/lanes")).filter((l) => !project || l.project === project);
  console.log(lanes.length ? lanes.map(laneLine).join("\n") : "No standing lane declares an attach command.");
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

/**
 * Claude Code statusline: Claude Code hands it the plan's limits from the headers of the replies it
 * already gets, so the office learns them without asking anyone. Prints a short line; a statusline
 * must never fail, so an office that is not running is only left out.
 */
async function statusline(): Promise<void> {
  type Window = { used_percentage?: number; resets_at?: number | string };
  let input: { model?: { display_name?: string }; rate_limits?: { five_hour?: Window | null; seven_day?: Window | null } | null } = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    // nothing readable: print what can be printed
  }
  const limits = [
    ["five_hour", "5h", input.rate_limits?.five_hour],
    ["week", "week", input.rate_limits?.seven_day],
  ].flatMap(([window, short, w]) => {
    const used = (w as Window | null | undefined)?.used_percentage;
    return typeof used === "number" ? [{ window: window as string, short: short as string, usedPercent: used, resetsAt: (w as Window).resets_at ?? null }] : [];
  });
  if (limits.length) await call("/api/agent/usage", { provider: "claude", limits: limits.map(({ short, ...l }) => l) }, 1000).catch(() => {});
  console.log([input.model?.display_name, ...limits.map((l) => `${l.short} ${Math.round(l.usedPercent)}%`)].filter(Boolean).join(" · "));
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "pipeline" && argv[1] === "install-hooks") return installHooksCommand(argv.slice(2));
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
    case "story": {
      if (!arg) throw new Error('inbox story needs your story: inbox story "…"');
      const saved = await call<{ story: string }>("/api/agent/story", { session: session(), text: arg });
      return console.log(`Office story saved: ${saved.story}`);
    }
    case "pipeline":
      return pipelineCommand(parsed.positionals.slice(1), flags, session());
    case "team":
      return console.log((await call<TeamBrief>("/api/agent/team", { session: session() })).text);
    case "crew":
      return console.log((await call<{ text: string }>("/api/agent/crew", { session: session() })).text);
    case "say": {
      const [, to, text] = parsed.positionals;
      if (!to || !text) throw new Error('inbox say needs a name and the text: inbox say NAME "text"');
      const message = await call<Message>("/api/agent/say", { session: session(), to, text, clientId: randomUUID() });
      if (message.toFounder) return console.log("Said to the founder: it shows in your panel in the office.");
      const offline = [...new Set(message.deliveries.flatMap((d) => d.offline ?? []))];
      if (offline.length) return console.log(`Queued for ${to}, but ${offline.join(" and ")} ${offline.length === 1 ? "is" : "are"} offline: it waits until they are back. If it holds you up for long, the founder is asked to make someone else lead.`);
      return console.log(`Sent to ${to}: it is typed into their terminal once they are free (${message.deliveries.length} ${message.deliveries.length === 1 ? "agent" : "agents"}).`);
    }
    case "handoff": {
      const s = session(); const pipeline = await deliveryBinding(s, flags.run, "handoff", flags);
      const { work } = await call<{ work: Work }>("/api/agent/handoff", { session: s, title: arg, summary: flags.summary, to: flags.to, work: flags.work, clientId: flags["client-id"] ?? randomUUID(), pipeline });
      return console.log(`Handed over as work ${work.id} (round ${work.round}). The verdict arrives as a message; \`inbox team\` shows where it stands.`);
    }
    case "review": {
      const verdict = parsed.positionals[2];
      if (!arg || !verdict) throw new Error('inbox review needs the work id and a verdict: inbox review ID accept|changes --notes "…"');
      const s = session(); const pipeline = await deliveryBinding(s, flags.run, "review", flags);
      const { work } = await call<{ work: Work }>("/api/agent/review", { session: s, work: arg, verdict, notes: flags.notes, pipeline, round: flags["work-round"] ? Number(flags["work-round"]) : undefined, clientId: flags["client-id"] ?? randomUUID() });
      return console.log(`Work ${work.id} is ${work.state === "accepted" ? "accepted" : "sent back with your notes"}; whoever handed it over is told.`);
    }
    case "switch":
      return switchAgents(arg);
    case "lane":
      return laneCommand(parsed.positionals.slice(1));
    case "qa":
      return qaCommand(arg, parsed.positionals[2]);
    case "surface-check":
      return surfaceCheck();
    case "pane": {
      const paneId = await openPane(resolve(flags.cwd ?? process.cwd()));
      // The agent that starts there joins the caller's team even outside its worktree. Opening the pane has worked, so this only warns.
      await call("/api/agent/pane", { session: session(), paneId }).catch((err: Error) => console.error(`inbox: the pane is open, but the office was not told whose crew it is for: ${err.message}`));
      return console.log(paneId);
    }
    case "hook":
      if (arg !== "claude") throw new Error("supported hooks: claude");
      return claudeHook();
    case "statusline":
      return statusline();
    default:
      throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
}

/** Checks a crew member's commit against the write surface its brief gave it; needs only git, not the office. */
function surfaceCheck(): void {
  const globs = parseWrites(flags.writes ?? []);
  if (!globs.length || !flags.base) throw new Error('inbox surface-check needs the write surface and the base: inbox surface-check --writes "GLOB,GLOB" --base SHA [--commit SHA]');
  const commit = flags.commit ?? "HEAD";
  const diff = execFileSync("git", ["diff", "--name-status", "-z", "-M", `${flags.base}..${commit}`, "--"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = changedFiles(diff);
  const stray = strayFiles(files, globs);
  const range = `${flags.base}..${commit}`;
  if (!stray.length) return console.log(`All ${files.length} changed ${files.length === 1 ? "file is" : "files are"} inside the write surface (${globs.join(", ")}) in ${range}.`);
  const how: Record<string, string> = { A: "added", D: "deleted", M: "modified", T: "type changed" };
  console.log([
    `${stray.length} of ${files.length} changed ${files.length === 1 ? "file is" : "files are"} outside the write surface (${globs.join(", ")}) in ${range}:`,
    ...stray.map((f) => `  ${f.path} (${how[f.status] ?? f.status})`),
  ].join("\n"));
  process.exitCode = 1;
}

/** The QA agent's commands: it decides for the founder through the office, and learns from the founder's own answers. */
async function qaCommand(sub: string | undefined, itemRef: string | undefined): Promise<void> {
  switch (sub) {
    case "guide":
      return console.log(QA_GUIDE);
    case "next": {
      const next = await call<QaNext>("/api/agent/qa/next", { session: session() });
      const learn = next.toLearn ? `\n${next.toLearn} founder ${next.toLearn === 1 ? "answer" : "answers"} to learn from first: inbox qa answers` : "";
      if (!next.item) return console.log(`Nothing waits for you.${learn}\nLearnings: ${next.learnings}`);
      const i = next.item;
      const kind = i.type === "decide" ? (i.options.length ? "decision" : "open question") : i.type === "try" ? "try-it" : "milestone";
      const how = i.type === "decide" ? (i.options.length ? "--choice ID" : '--answer "words"') : '--accept | --request-changes "what"';
      return console.log([
        `${next.waiting} waiting. Next: ${kind} ${i.id} revision ${i.revision} · ${i.project} · ${i.taskTitle}${i.blocking ? " · the agent is waiting on it" : ""}`,
        `Title: ${i.title}`, i.request ? `Request: ${i.request}` : "", i.context ? `Context:\n${i.context}` : "", i.check ? `What to check: ${i.check}` : "",
        ...i.options.map((o) => `  ${o.id}) ${o.label}${o.consequence ? ` — ${o.consequence}` : ""}`),
        i.recommendation ? `Recommendation: ${i.recommendation}` : "",
        ...i.pages.map((p) => `Page: ${p.label} ${p.url}${p.look ? ` (${p.look})` : ""}`),
        "", `Learnings: ${next.learnings}`,
        next.predicting ? "Manual mode: the founder answers this; your answer is recorded only as your prediction of theirs, never sent." : "",
        `${next.predicting ? "Predict" : "Decide"}: inbox qa answer ${i.id} --revision ${i.revision} ${how} --reason "why" [--learning SLUG]`, learn,
      ].filter((l) => l !== "").join("\n"));
    }
    case "answer": {
      if (!itemRef || !flags.revision) throw new Error("inbox qa answer needs the item and its revision: inbox qa answer ITEM --revision N …");
      const picked = [flags.choice !== undefined, flags.answer !== undefined, Boolean(flags.accept), flags["request-changes"] !== undefined].filter(Boolean).length;
      if (picked !== 1) throw new Error('give exactly one of --choice ID, --answer "words", --accept or --request-changes "what"');
      const action = flags.choice !== undefined ? "choose" : flags.answer !== undefined ? "answer" : flags.accept ? "accept" : "request_changes";
      const reply = await call<Reply | QaPrediction>("/api/agent/qa/answer", {
        session: session(), item: itemRef, revision: Number(flags.revision), action, choice: flags.choice,
        text: flags.answer ?? flags["request-changes"], reason: flags.reason ?? "", learnings: flags.learning,
      });
      if ("predicted" in reply) return console.log(`Predicted (manual mode, not sent): ${reply.action}${reply.choice ? ` ${reply.choice}` : ""}. It is compared with the founder's own answer.`);
      return console.log(`Answered for the founder (marked as yours): ${reply.action}${reply.choice ? ` ${reply.choice}` : ""}. The founder can override it.`);
    }
    case "answers": {
      const feed = await call<{ answers: FounderAnswer[]; remaining: number; learnedThrough: number }>("/api/agent/qa/answers", { session: session(), limit: flags.limit ? Number(flags.limit) : undefined });
      if (!feed.answers.length) return console.log("Nothing new: you have learned from every founder answer.");
      for (const a of feed.answers) {
        const said = a.action === "choose" ? `chose ${a.choiceLabel ?? a.choice}` : a.action === "accept" ? "accepted" : a.action === "request_changes" ? "asked for changes" : a.action === "answer" ? "answered in words" : "said (discuss)";
        console.log([
          `seq ${a.seq} · ${a.at} · ${a.project} · ${a.itemType} ${a.itemId} r${a.revision}: ${a.title}`,
          a.request ? `  Request: ${a.request}` : "", ...a.options.map((o) => `    ${o.id}) ${o.label}`), a.recommendation ? `  Recommended: ${a.recommendation}` : "",
          `  The founder ${said}${a.text ? `: ${a.text}` : ""}`,
          a.overrode ? `  OVERRODE your ${a.overrode.action}${a.overrode.choice ? ` ${a.overrode.choice}` : ""}${a.overrode.learnings.length ? ` (learnings: ${a.overrode.learnings.join(", ")})` : ""}` : "",
          a.predicted ? predictionLine(a, a.predicted) : "",
        ].filter(Boolean).join("\n"));
      }
      return console.log(`\nOnce learned: inbox qa learned --through ${feed.answers.at(-1)!.seq}${feed.remaining ? ` (${feed.remaining} more after these)` : ""}`);
    }
    case "judge": {
      if (!itemRef || !flags.revision || Boolean(flags.match) === Boolean(flags.mismatch)) throw new Error("inbox qa judge ITEM --revision N (--match | --mismatch)");
      const judged = await call<QaPrediction>("/api/agent/qa/judge", { session: session(), item: itemRef, revision: Number(flags.revision), agrees: Boolean(flags.match) });
      return console.log(`Judged your prediction for ${judged.itemId} r${judged.revision}: ${judged.verdict}.`);
    }
    case "learned": {
      if (!flags.through) throw new Error("inbox qa learned needs --through SEQ");
      const done = await call<{ learnedThrough: number }>("/api/agent/qa/learned", { session: session(), through: Number(flags.through) });
      return console.log(`Learned through ${done.learnedThrough}.`);
    }
    default:
      throw new Error("inbox qa next | answer | answers | judge | learned | guide");
  }
}

/** Your prediction beside the founder's answer: a mismatch is as strong a signal as an override. */
function predictionLine(a: FounderAnswer, p: QaPrediction): string {
  const said = `${p.action}${p.choice ? ` ${p.choice}` : ""}${p.text ? `: ${p.text}` : ""}${p.learnings.length ? ` (learnings: ${p.learnings.join(", ")})` : ""}`;
  if (p.verdict === "mismatch") return `  MISMATCH: you predicted ${said}`;
  if (p.verdict === "needs_judging") return `  JUDGE: you predicted ${said}\n  Did it agree with the founder's words? inbox qa judge ${a.itemId} --revision ${a.revision} --match | --mismatch`;
  return `  Matched your prediction: ${said}`;
}

export function run(argv = process.argv.slice(2)): void {
  main(argv).catch((err: Error) => {
    console.error(`inbox: ${err.message}`);
    process.exit(1);
  });
}
