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
| **Decide** | the question, 2+ options with consequences, the agent's recommendation, screenshots | pick an option (plus an optional note) |
| **Try it** | what to check, a live preview (checked for reachability, embeddable at desktop or phone width), setup notes | open it, then "Tried it" with a note |
| **Review milestone** | what was finished, evidence at the exact revision | Accept, or Request changes (text required) |

**Discuss** (free text to the owning agent) and **Later** (snooze 1 h / 3 h / tomorrow, or mark handled) are on every type. A choice never stops you writing more.

## Layout

- **Left rail**: Needs you / Working / Parked with counts; projects with waiting counts and pins; herdr status; key hints.
- **Queue** (Needs you): filter chips by type with counts. The sort is stated on screen: pinned projects, then items an agent is blocked on, then the longest waiting. `n` opens the next item, `j`/`k` move. Each card shows type, task · project, age, a thumbnail, owner and harness, and whether the agent is waiting.
- **Detail**:
  - The header shows owner, harness, live status and Open conversation.
  - Tabs appear only when they have content: Context (with the task brief), Screenshots (older revisions dimmed), Live preview, Conversation (your replies with their delivery state and a Retry).
  - The answer area is pinned at the bottom.
- **Working / Parked**: one card per task with its brief (objective, latest decision, last accepted milestone, doing now, next milestone), its open items and Park / Open conversation. Parking hides a task's items from Needs you; it does not pause the agent.

The **task brief** is project memory for you rather than for the model. It is edited by hand, and updated when you pick an option or accept a milestone.

## Correctness rules

- **Stable ids.** An item is `(task, key)`. Resubmitting the same key with identical content changes nothing. Changed content becomes a new revision.
- **Stale answers are visible.** A reply carries the revision it answered. Answering an out-of-date revision is refused (409). A queued reply that a new revision overtakes turns `stale`, and the conversation says so.
- **Delivery is acknowledged.** A reply is `queued` until an integration claims it, and `delivered` only after that integration acks it. If a claim has no ack after 30 s, the reply is shown as *uncertain*. A failed delivery returns the item to Needs you with Retry. Each send carries a client-made id, so a retried request never becomes a second answer.
- **Only the owner reads its replies**: session id plus harness must match.
- **Loopback only.** The service binds 127.0.0.1 and checks the Host header (against DNS rebinding). Writes require `application/json` and a same-origin `Origin`.
- **Only explicit attachments.** Evidence is copied from paths the agent names, by type allowlist and size limit, never dotfiles. It is served with a sandbox CSP. The preview check fetches only that item's own http(s) URL.
- **State lives outside worktrees** (`~/.review-inbox`), so branch switches and worktree deletion never lose it. A project is a repository's git common dir, so all its worktrees are one project.

## The office

The office is a second view of the same state, not a second system. It adds two things the inbox did not keep:

- **Agent identity** is harness plus checkout (`pi:/…/space-shuttle-einstein`), not the session, plus herdr's name for an agent herdr knows by one (`claude:/…/space-shuttle-atoms@tests`), so a first mate's crew sharing its checkout stay apart. A lane restarted in its worktree is the same person with the same name, face and desk. The face is derived from the identity alone, so it never needs storing.
- **Projects and standing teams** (`teams`, `world_agents`; "team" in the code): a name, and exactly one lead once anyone is on it (the service appoints one: someone running, there longest). A **project** is a worktree (`path`, `branch`): an agent placed nowhere whose checkout is a linked worktree is on that worktree's project, made on first sight and named after the folder. Its lead is the first mate, briefed to plan, start crew in herdr and supervise rather than write code. A **standing** team (Mission Control) has no worktree and keeps its members wherever they work. Offline, a standing team's members and a project's lead keep an empty desk; anyone else who stops running leaves.

**Starting and finishing a project** go through herdr, which owns worktrees and panes. Starting makes the worktree beside the main checkout, on a new branch from the main checkout's branch, and starts Claude Code there as first mate (`--model opus --effort medium`, the brief appended to its system prompt). A folder-trust question at start is left for you to answer in herdr. Finishing refuses while work waits for the team's review, anyone there is working, or `git status` shows anything, since removing the worktree would lose it. Then it closes every pane working in the worktree, removes it, and deletes the branch with `git branch -d`, which keeps an unmerged branch (the note says how many commits the main checkout's branch lacks). A project whose worktree has gone is forgotten.

Agents come from herdr (all of them, including those that never posted) and from inbox tasks, joined on the session.

**Team status** is derived, never stored. A team is `blocked` when its lead is stuck, or when someone is stuck and nobody in it is still working; stuck means waiting at a prompt in herdr or waiting on a blocking inbox item. A crew member stuck while the lead works is the lead's to handle, so it does not reach you. Otherwise the team is `working`, `idle` or `offline`. The service announces a team through herdr's notifications once, on the change to blocked; on start it only takes note of how things stand.

**Messages** (`messages`, `message_deliveries`) are everything said in the office: your instruction to a team, an agent's message to another agent or a team, a handoff and a review verdict. They are kept like replies: never deleted, one delivery row per agent, and a client id so a retried request is not a second message. The agents a message goes to are fixed when it is given: a team's lead, or its crew (the running ones, else all) when the lead is the one speaking. A delivery is `queued` until its agent is free, then claimed as `sending` by a conditional update, so two reactions never type it twice, and ends `delivered` or `failed` (with herdr's reason, and a Retry). Each agent takes one message at a time, oldest first. The text is prefixed with who is asking, the team and the agent's part in it: a first mate is told to plan it, give it to its named crew or start more in herdr, supervise them and report the outcome; a standing team's lead to divide it among its crew. Agents talking to each other cost tokens on both sides, so each may send 30 messages an hour.

**Work** (`work`) is finished work handed to another team to review: the team named, or the one the sender's team `handsTo`. It is `in_review` until that team (and only it) answers `accepted` or `changes_requested`; changes need notes. The verdict is a message back to whoever handed it over, and handing the same work over again starts its next round. The service decides nothing about the work itself: whether it is good is the reviewing agents' judgement.

**Activity** is what an agent is doing right now (its current tool, as one line) and its **helpers** (sub-agents). It comes from the harness: Claude Code through an HTTP hook (`/api/hooks/claude`: PreToolUse, SubagentStart/Stop, Stop), Pi through its extension (`/api/agent/events`). It is kept in memory only, because it describes the last minutes: a tool line fades after two minutes, a helper nobody hears from after thirty, and a finished turn clears both. Activity changes are broadcast but never make the service react, so they cannot trigger a delivery.

The office draws all of this from the same state, without storing anything of its own. A message that arrives while you watch becomes a **visit**: the sender walks to the first recipient, says it in a speech bubble (carrying a folder for a handoff) and walks back. Your own instructions are bubbles over the agents that hear them. The `handsTo` links are arrows between team corners. The **board** (`#/teams`) shows the same projects, work and messages as columns and lists.

The queue at your desk is `needsYou` from the inbox, one place per agent. The terminal is `herdr agent read`, only while a panel is open, and only on loopback like everything else.

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
