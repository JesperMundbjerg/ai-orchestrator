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

The one exception is a **team instruction** (below). It is a new prompt, not an answer to anything the agent asked, and an idle agent has no turn boundary where a hook could hand it over. So it is typed with `herdr agent prompt`, under three guards: it is sent only when herdr reports the agent idle or done, herdr itself refuses an agent that is asking something, and herdr must see the agent start working within seconds for the delivery to count.

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

- **Agent identity** is harness plus checkout (`pi:/…/space-shuttle-einstein`), not the session. A lane restarted in its worktree is the same person with the same name, face and desk. Two agents in one checkout get separate identities. The face is derived from the identity alone, so it never needs storing.
- **Teams** (`teams`, `world_agents`): a name, a structure (`dispatch` or `circle`) and at most one lead. A team member who is not running keeps an empty desk; an agent in the lounge who stops running leaves.

Agents come from herdr (all of them, including those that never posted) and from inbox tasks, joined on the session.

**Team status** is derived, never stored. A team is `blocked` when its lead is stuck, or when someone is stuck and nobody in it is still working; stuck means waiting at a prompt in herdr or waiting on a blocking inbox item. A crew member stuck while the lead works is the lead's to handle, so it does not reach you. Otherwise the team is `working`, `idle` or `offline`. The service announces a team through herdr's notifications once, on the change to blocked; on start it only takes note of how things stand.

**Team instructions** (`team_orders`, `order_deliveries`) are kept like replies: never deleted, one delivery row per agent, and a client id so a retried request is not a second order. The agents an order goes to are fixed when it is given: the lead of a dispatch team, or every running peer of a circle. A delivery is `queued` until its agent is free, then claimed as `sending` by a conditional update, so two reactions never type it twice, and ends `delivered` or `failed` (with herdr's reason, and a Retry). Each agent takes one order at a time, oldest first. The text is prefixed with who is asking, the team and the agent's part in it: the lead is told to divide the work among its named crew, a peer to settle it with the named others. The queue at your desk is `needsYou` from the inbox, one place per agent. The terminal is `herdr agent read`, only while a panel is open, and only on loopback like everything else.

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
