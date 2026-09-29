# Design

The Review Inbox is for projects that run for weeks, where agents need your judgement more often than they need your typing. Mission-control tools show you terminals. This one shows only the moments that need you, with the evidence to decide from, and routes your answer back to the conversation that asked.

## What the UI talks to

**The UI talks only to the local service.** It uses HTTP for reads and actions and one SSE stream (`/api/events`) that says "something changed". It never talks to an agent, a harness or herdr.

This keeps the UI vendor-neutral. The service keeps three things per task:

| Kept | Why |
|---|---|
| **Harness** (`pi`, `claude`, `codex`, `manual`) | shown as a label; it picks the setup hint, never a code path in the UI |
| **Stable session id** (Pi: session file; Claude: `CLAUDE_CODE_SESSION_ID`; Codex: `CODEX_THREAD_ID`; else the herdr pane resolved to its agent session) | the reply's address. It survives restarts, and it is the same id herdr reports, so presence joins on it |
| **Capabilities**, learned from behaviour | what the UI branches on |

The reply route is **learned, not configured**:
- **live**: an integration has polled with `mode: "live"` in the last 15 s (the Pi extension). The reply appears in the running session within seconds.
- **boundary**: a hook has called (Claude Code Stop / UserPromptSubmit / SessionStart). The reply lands at the next turn boundary.
- **pull**: neither has happened. The reply waits for `inbox replies`.

The UI shows the route as one sentence under the answer area, so you know what "sent" means before you send.

**herdr is a presence provider, not a bus.** The service reads `herdr agent list` for status (working / idle / blocked / done) again whenever herdr's socket reports a status change or a pane coming or going, with polling as the fallback. It uses `herdr agent focus` for **Open conversation**. Replies never go through a terminal: typing into panes cannot be acknowledged, races the agent's own input, and would tie the inbox to one multiplexer. When herdr is missing, presence shows "unknown" and nothing else changes.

The one exception is a **message in the office** (below): your instruction to a team, or one agent to another. It is a new prompt, not an answer to anything the agent asked, and an idle agent has no turn boundary where a hook could hand it over. So it is typed with `herdr agent prompt`, under three guards: it is sent only when herdr reports the agent idle or done, herdr itself refuses an agent that is asking something, and herdr must see the agent start working within seconds for the delivery to count.

## The three item types

| Type | You get | Primary actions |
|---|---|---|
| **Decide** | the question as the title, what the agent needs and what happens if nobody answers, 2+ options with consequences, the agent's pick and why, screenshots | pick an option (plus an optional note) |
| **Try it** | what to check, a live preview or a walkthrough of pages (each checked for reachability and framing, shown at desktop or phone width), setup notes | open it, then "Tried it" with a note |
| **Review milestone** | what was finished, evidence at the exact revision | Accept, or Request changes (text required) |

**Discuss** (free text to the owning agent) and **Later** (snooze 1 h / 3 h / tomorrow, or mark handled) are on every type. A choice never stops you writing more.

## Layout

- **Left rail**: Needs you / Working / Parked with counts; projects with waiting counts and pins; herdr status; key hints.
- **Queue** (Needs you): filter chips by type with counts. The sort is stated on screen: pinned projects, then items an agent is blocked on, then the longest waiting. `n` opens the next item, `j`/`k` move. Each card shows type, task · project, age, a thumbnail, owner and harness, and whether the agent is waiting.
- **Detail**:
  - The header shows owner, harness, live status and Open conversation.
  - Tabs appear only when they have content: Context (with the task brief), Screenshots (older revisions dimmed), Live preview (or Pages, a walkthrough: one live frame at a time with what to look at, Previous/Next and ← →, opened first when there are several; a page that is down or refuses framing says so with an open-in-tab link), Conversation (your replies with their delivery state and a Retry).
  - The answer area is pinned at the bottom.
- **Working / Parked**: one card per task with its brief (objective, latest decision, last accepted milestone, doing now, next milestone), its open items and Park / Open conversation. Parking hides a task's items from Needs you; it does not pause the agent.

The **task brief** is project memory for you rather than for the model. It is edited by hand, and updated when you pick an option or accept a milestone.

## Correctness rules

- **Stable ids.** An item is `(task, key)`. Resubmitting the same key with identical content changes nothing. Changed content becomes a new revision.
- **Stale answers are visible.** A reply carries the revision it answered. Answering an out-of-date revision is refused (409). A queued reply that a new revision overtakes turns `stale`, and the conversation says so.
- **Delivery is acknowledged.** A reply is `queued` until an integration claims it, and `delivered` only after that integration acks it. If a claim has no ack after 30 s, the reply is shown as *uncertain*. A failed delivery returns the item to Needs you with Retry. Each send carries a client-made id, so a retried request never becomes a second answer.
- **Only the owner reads its replies**: session id plus harness must match.
- **Loopback only.** The service binds 127.0.0.1 and checks the Host header (against DNS rebinding). Writes require `application/json` and a same-origin `Origin`.
- **Only explicit attachments.** Evidence is copied from paths the agent names, by type allowlist and size limit, never dotfiles. It is served with a sandbox CSP. The preview check fetches only that item's own http(s) URLs. Pages are http(s) only and framed sandboxed; a page on the office's own origin gets no same-origin rights.
- **State lives outside worktrees** (`~/.review-inbox`), so branch switches and worktree deletion never lose it. A project is a repository's git common dir, so all its worktrees are one project.

## The office

The office is a second view of the same state, not a second system. It adds two things the inbox did not keep:

- **Agent identity** is harness plus checkout (`pi:/…/space-shuttle-einstein`), not the session, plus herdr's name for an agent herdr knows by one (`claude:/…/space-shuttle-atoms@tests`), so a first mate's crew sharing its checkout stay apart. A lane restarted in its worktree is the same person with the same name, face and desk. The face is derived from the identity alone, so it never needs storing.
- **Projects and standing teams** (`teams`, `world_agents`; "team" in the code): a name, and exactly one lead once anyone is on it (the service appoints one: someone running, there longest). A **project** is a worktree (`path`, `branch`): an agent placed nowhere whose checkout is a linked worktree is on that worktree's project, made on first sight and named after the folder. Its lead is the first mate, briefed to plan, start crew in herdr and supervise rather than write code. A **standing** team (Mission Control) has no worktree and keeps its members wherever they work. Offline, a standing team's members and a project's lead keep an empty desk; anyone else who stops running leaves.

**Starting and finishing a project** go through herdr, which owns worktrees and panes. The repository is one someone already works in, or any main checkout named by its path. Starting makes the worktree beside the main checkout, on a new branch from the main checkout's branch, and starts Claude Code there as first mate (`--model opus --effort medium`, the brief appended to its system prompt). Whoever runs in the pane it was started in (`lead_pane`) is the project's lead, whatever herdr calls it: herdr can lose the name it started the agent with, which makes a second record, so a lead record left offline is folded into the running one, which keeps its name and what was said to it. A lead who is running, such as one you picked, is left alone. For a project from before that, a running agent's panel offers to make it the lead and take the name of a lead record that never ran (the same fold). Someone nothing runs behind can be removed from the office: the record is kept but hidden, so what it said and handed over keeps its sender, its undelivered messages are dropped, and the team's longest-standing running member leads next. It is refused while the agent runs, and running again brings it back. A folder-trust question at start is left for you to answer in herdr. Finishing refuses while work waits for the team's review, anyone there is working, or `git status` shows anything, since removing the worktree would lose it. Then it closes every pane working in the worktree, removes it, and deletes the branch with `git branch -d`, which keeps an unmerged branch (the note says how many commits the main checkout's branch lacks). A project whose worktree has gone is forgotten.

Agents come from herdr (all of them, including those that never posted) and from inbox tasks, joined on the session.

A repository can describe itself in **`orchestrator.json`** at its main checkout (the project adapter, [ORCHESTRATION.md](ORCHESTRATION.md)): its key in `/api/p/:project`, integration branch, preview address, comment kinds and anchor keys, checks, reviewers, landing commands and standing lanes. The service shows it on the repository in the world state and never runs anything from it. It is read again when the file changes; a missing file is no adapter, and an invalid one is not used at all, with every problem listed (`adapterProblems`) rather than half-applied. Keys it does not know are listed and ignored. `GET /api/p/:project/queue` gives the project's own tools who works its queue: each of the adapter's `lanes` joined to an office agent (the one working in the lane's `worktree`, the one whose herdr name or Pi session name is exactly its `agent`, or both when both are given; with neither, the agent called by the lane's name), with its state, what it is doing, its branch and model. A Pi session's name is the one in its terminal title (`/name`); the Pi extension reports it, and the service keeps it per session in memory like the model, so a new session in the same checkout has not said it and a restarted office hears it again at the session's next turn or poll. A lane with `agent` never falls back to another agent, such as a Claude Code session in the same folder. A lane nobody runs in is listed `offline` with why. The comment counts stay empty until comments live here (ORCHESTRATION.md, step 5). `inbox say <name>` also takes a lane's name, after office names and teams: it reaches the same agent, so a project's tools message their lanes by the names they already use. A name that is a lane in several projects means the sender's own.

**Team status** is derived, never stored. A team is `blocked` when its lead is stuck, or when someone is stuck and nobody in it is still working; stuck means waiting at a prompt in herdr or waiting on a blocking inbox item. A crew member stuck while the lead works is the lead's to handle, so it does not reach you. Otherwise the team is `working`, `idle` or `offline`. The service announces a team through herdr's notifications once, on the change to blocked; on start it only takes note of how things stand.

**Messages** (`messages`, `message_deliveries`) are everything said in the office: your instruction to a team, an agent's message to another agent or a team, a handoff and a review verdict. They are kept like replies: never deleted, one delivery row per agent, and a client id so a retried request is not a second message. The agents a message goes to are fixed when it is given: a team's lead, or its crew (the running ones, else all) when the lead is the one speaking. A delivery is `queued` until its agent is free, then claimed as `sending` by a conditional update, so two reactions never type it twice, and ends `delivered` or `failed` (with herdr's reason, and a Retry). Each agent takes one message at a time, oldest first. The text is prefixed with who is asking, the team and the agent's part in it: a first mate is told to plan it, give it to its named crew or start more in herdr, supervise them and report the outcome; a standing team's lead to divide it among its crew. Agents talking to each other cost tokens on both sides, so each may send 30 messages an hour. An agent **answers you** with `inbox say founder "…"`: a message marked `to_founder`, with no deliveries, so it is typed into no terminal and is not an inbox item; it counts toward the same hourly limit. The office keeps your conversation with the agents apart from the rest of its talk (the latest 200), and an agent's panel shows it as a thread above the message box: what you said to it or to the team it leads, and its answers. Your messages tell the agent to answer in a sentence or two and to follow up the same way when the job is done or something new happens; decisions still go to `inbox decide`. No agent can be named "founder".

**Work** (`work`) is finished work handed to another team to review: the team named, or the one the sender's team `handsTo`. It is `in_review` until that team (and only it) answers `accepted` or `changes_requested`; changes need notes. The verdict is a message back to whoever handed it over, and handing the same work over again starts its next round. The service decides nothing about the work itself: whether it is good is the reviewing agents' judgement.

**Activity** is what an agent is doing right now (its current tool, as one line) and its **helpers** (sub-agents). It comes from the harness: Claude Code through an HTTP hook (`/api/hooks/claude`: PreToolUse, SubagentStart/Stop, Stop), Pi through its extension (`/api/agent/events`). It is kept in memory only, because it describes the last minutes: a tool line fades after two minutes, a helper nobody hears from after thirty, and a finished turn clears both. Activity changes are broadcast but never make the service react, so they cannot trigger a delivery. The **model** an agent runs is reported the same way, for the session that reported it: Claude Code's from the hook input's `model` (SessionStart, through `inbox hook claude`) or its transcript's latest reply (read at each Stop, or when none is known yet), Pi's from `ctx.model` at session start, on `model_select` and at each turn's end. When a harness has not reported it (a Pi agent started before the extension did, Codex, Claude Code without the hooks), the service reads the session file the harness itself keeps: Pi's session file (its latest `model_change` or assistant message), Codex's rollout (its latest `turn_context`), Claude Code's transcript. That read is lazy, when the office is drawn, and repeated only once the file has grown and at most every ten seconds; what the harness reports wins over it. Every path names the model the same way, specific rather than a family ("Opus 5.5", "GPT-6"), with the raw id beside it; the office shows nothing when no model is known.

The office draws all of this from the same state, without storing anything of its own. Its corners stand on a **ring round your desk**, each facing it, so every team is about as close to you as any other: the first straight ahead, the next alternately right and left, then the lounge. They stand side by side from the front until the ring is full, so a new team takes the next place without moving anyone; after that the ring widens just enough for all of them to fit evenly, and nobody changes sides. People walk round a path inside the ring and in to where they are going, so no walk crosses a desk or another corner. A message that arrives while you watch becomes a **visit**: the sender walks to the first recipient, says it in a speech bubble (carrying a folder for a handoff) and walks back. Your own instructions are bubbles over the agents that hear them. A blocked team is standing state rather than an event: its running lead stands at your side of the desk, facing you, for as long as the team is blocked, and a card offers what fits (the answer card for a decision; for someone at a prompt, who it is, a message asking the lead to handle it, or their panel). The office offers no allow or deny, since it cannot see the prompt. Sending the lead back holds until who is stuck, or why, changes; it is kept in the page only. The `handsTo` links are arrows between team corners, round the desk just outside the path. The **board** (`#/teams`) shows the same projects, work and messages as columns and lists.

The queue at your desk is `needsYou` from the inbox, one place per agent. The office never shows an agent's terminal: you read what they are doing and what was said, and a message to one agent goes through the same deliveries as everything else. herdr's own errors reach the UI as one line.

## Codex

Codex posts through the CLI and receives by **pull** today. Two routes could make it boundary or live; each needs a check against the installed Codex before building on it:
1. **Codex hooks** (a Stop-style hook). This would reuse the Claude hook's shape.
2. **`codex queue --thread <id>`** to push a follow-up into a running thread. This would give live delivery without a terminal.

Also unconfirmed: that Codex exports the thread id to tool shells as `CODEX_THREAD_ID`. Until that is checked, run the CLI with `--harness codex --session <thread id>` or inside herdr, which resolves the pane.

## Delivery stages

1. **Clickable prototype with three projects.** Done: `npm run demo`.
2. **One real round trip.** The protocol path works end to end: the demo's live listener receives the decision and acks it. Not yet run: the same inside a real Pi session with the extension loaded.
3. Three real projects in parallel for a week.
4. Harden: whatever week 3 breaks.

## Deliberately not here

- A reasoning agent that triages or summarises. The agents already hold the context.
- Live voice conversation (a later layer).
- Model API calls of any kind.
