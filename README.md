# Review Inbox

A local inbox for long-running agent projects. Agents in Pi, Claude Code or Codex post the moments that need you: a **decision**, something to **try**, or a **milestone** to review. You work through one queue, and each reply goes back to the conversation that asked.

- It runs on your machine and binds `127.0.0.1` only. It makes no model API calls; the agents run on your own subscriptions.
- There is no reasoning agent in the middle. The service stores, routes and shows. Your agents do the thinking.
- It is vendor-neutral. The UI never talks to an agent. It talks to the service, and the service knows each agent only by harness, session id and what that harness has shown it can do.

Design and the reasons behind it: [docs/DESIGN.md](docs/DESIGN.md). Instructions for agents working in this repo: [AGENTS.md](AGENTS.md).

## Run it

Needs Node 24+ (built-in SQLite and TypeScript type stripping).

```sh
npm install
npm run build      # the UI, into dist/
npm start          # http://127.0.0.1:4870, data in ~/.review-inbox
```

Try it with sample data: run `npm run demo` in a second terminal. It posts three projects through the agent protocol, the same way real agents do. It then stays running as the first project's Pi agent: answer its decision in the browser and the reply prints in that terminal.

For UI work, `npm run dev` starts the service with `--watch` and the Vite UI on http://127.0.0.1:4871.

| Variable | Default | |
|---|---|---|
| `INBOX_PORT` | `4870` | service port |
| `INBOX_DATA_DIR` | `~/.review-inbox` | SQLite database and copied evidence, outside every worktree |
| `INBOX_URL` | `http://127.0.0.1:$INBOX_PORT` | where agent-side tools find the service |

## Restart the office

```sh
npm run restart-office            # add -- --build to rebuild the UI first
```

It stops the office listening on `INBOX_PORT` (only if that is `node src/server/main.ts`; anything else is left alone), starts this checkout's service in the background with its output appended to `office.log` in the data directory, and prints `Office restarted on 4870 (pid N)` once `/api/world` answers, or what went wrong. herdr's `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` come from the environment, else from `office.env` (`KEY=VALUE` lines) in the data directory, else from the running office's own environment. It never stops herdr.

## The office

**Walk into the office** in the sidebar (or open `/#/world`) for the same agents as people in a 3D office:

- Every agent herdr sees gets a stable name and face, kept across session restarts because they are tied to the harness and checkout (and to herdr's name for an agent that shares a checkout). Rename anyone in their panel.
- A **project** is a worktree: every agent working in one is on that project, the first there leads it, and a worktree seen for the first time becomes a project named after its folder. Its lead is the **first mate**: your one contact, who splits the work, starts crew in herdr (Sonnet for most tasks, Opus at medium effort for deep thinking), supervises them and brings you only decisions and milestones. **Standing teams** such as Mission Control are always on and keep their members, whatever checkout they work in. Each gets a corner on a ring round your desk, facing you: the lead at the back of the room, the crew at their craft stations facing the team's corkboard: its name cut out of paper, a paper stickman pinned on for each member and a green one under them for each working now, and pinned notes for its branch (or Always on) and, in red, who holds it up when it is blocked. There are no desks: a member at work makes something by hand (a chair or table at a woodwork bench, a painting at an easel, a pot on a wheel, a bust, cloth on a loom) and the piece grows while they work; a member waiting or done stands at their station. Agents on no project wait in the lounge, which has its place on the ring too.
- The **lamp** over each head is their live status: green working, amber waiting at a prompt, blue finished a turn, dim idle, dark offline.
- **Click someone** and start typing to **message them**: it is typed into their terminal once they are free. Above the box is your conversation with them: what you said and their short answers (`inbox say founder`), updated as they follow up. Their panel also shows what they are doing and what else was said, and moves them to another project.
- **Paste or drop an image** into any box where you write to an agent (a message, an instruction, an answer or a note in the inbox) to show it: a thumbnail you can remove waits beside the text, and the thread shows it after sending (click to enlarge). PNG, JPEG, GIF or WebP up to 10 MB, stored in `uploads/` in the data directory. The agent reads it from the path it is given (`Image: /…/uploads/<id>.png`), since the text is typed into a terminal.
- **Click a project** in the list for where it stands, what each member is doing, and a box to **tell it** what to do. Its first mate (or a standing team's lead) hears it and runs the crew. The instruction is typed into the terminal as soon as it is free, and the panel shows how far it got.
- **+ New project** makes a worktree beside the repository's main checkout (`space-shuttle-atoms-light` on branch `worktree-atoms-light`, from the branch the main checkout is on) and starts its first mate there with Claude Code. **Finish project** closes its agents and removes the worktree; it refuses while anything there is uncommitted or anyone is working, and deletes the branch only once it is merged. A worktree removed some other way ends its project too.
- A project can have a **purpose** (every member is told) and a team it **hands its finished work to**, drawn as arrows between corners. Agents talk with `inbox say`, hand work over with `inbox handoff` and review it with `inbox review` (below). You see them walk over and say it, with a folder when they hand work over; your own instructions appear as speech bubbles.
- A lamp only says *that* someone works. With the activity hooks (below) they also show **what** they are doing ("Editing Office.tsx") and their **helpers**: sub-agents stand behind them, small, for as long as they run.
- A team is **blocked** when its lead is stuck (at a prompt, or waiting on your answer), or when someone is and nobody else is still working. It turns red, and herdr shows you a notification once, when it happens. A single crew member stuck while the lead works is the lead's to handle.
- A blocked team's **lead comes to your desk**, stands in front of you and stays until it is unblocked or you send them back (**Not now**, or Esc). A card says what they need: a decision opens as its answer card, with any screenshot; someone stuck at a prompt is named in one line, with **Let the lead handle it** (a message to the lead) or **Open** that agent. The office cannot see what a prompt asks, so it never answers one for you.
- When an agent has something for you, they walk to **your desk** and queue there holding a card: purple for a decision, green to try something, orange for a milestone. Click them to answer. The line keeps the inbox's order, so an agent blocked on you is let to the front. Once answered, they walk back to their desk.

**Headless browsers left running.** Every 15 s the service reads the process list for browsers a program started (a headless build, `--headless`, or a Playwright or Puppeteer profile), groups each with its pages and helper processes, and works out whose it is from the folder of the process that started it (a dev server in a project's worktree makes it that project's). **The office closes a forgotten one by itself**: SIGTERM to its main process, and SIGKILL to that process alone if it is still running 10 s later. Forgotten means its starter has exited (it was taken over by launchd or init) for a minute while its project has had no busy agent for that minute (a browser of no project: while it uses under 5% CPU), or it has run over 10 minutes while its project has had no busy agent that long (no project: under 5% CPU that long). A browser of a project with a busy agent is never closed this way, even an orphan, since it may be mid-screenshot or deliberately detached and reused. When one is closed, the project's lead gets one short message from the office (*Closed a headless browser left running by Cosmology lesson: 3 pages, 10 min idle; close browsers in a finally*; a project hears at most every 15 minutes), and the Projects board says quietly *Closed 2 forgotten browsers today*. Browsers that may still be in use are only a warning, under the top bar of the office and the Projects board, when together they use more than 1.5 cores for a minute or more than five run at once: *Headless browsers are using 3 cores: Cosmology lesson browser (6 pages, 250%, 12 min) [Close]*. **Close** asks that one browser to quit (SIGTERM); a browser the office could not close is listed the same way. The service signals only a headless browser it lists, read from the process list again just before, and nothing else is ever closed automatically. First mates are briefed to have their crew close every browser they open. They are also briefed that crew never open a visible browser window, since the founder's screen jumps to it: headless browsers (Playwright headless can still use the GPU with `--use-angle=metal`), pages shown to the founder through the review inbox (`--page`) and never `open URL`, and `open -g` (macOS, background, no focus) when a real window cannot be avoided. `GET /api/machine` gives the same list and the day's count.

**Projects** in the sidebar (`/#/teams`) is the same without walking: a column per project and standing team with its status, branch, purpose and members. Start and finish projects, drag people between columns (or to the lounge), pick the lead, tell a project what to do, and follow the work handed over and what was said.

WASD or the arrow keys walk, Shift runs, dragging turns the view with the pointer (drag right to turn right, up to look up), and scrolling, pinching or + and − zoom. Zooming out past the widest view lifts you up for an overview of the whole ring; zooming in brings you back down.

The service talks to the herdr session it was started in (`HERDR_SOCKET_PATH`), or herdr's default session when started outside herdr. Start it from a pane in the session your agents run in.

## Connect an agent

Every harness can use the `inbox` CLI (`npm link` puts it on `PATH`):

```sh
inbox decide "Should the tutor cover the slider or push it aside?" \
  --request "I need this to finish the isotope step. Until you answer I'll keep it docked." \
  --option "Overlay: tutor covers the right third; slider hidden while it talks" \
  --option "Docked: the stage narrows; everything stays visible" \
  --recommend "Docked, because the lesson depends on the slider staying in view" --screenshot shots/open.png
inbox try "Try the receipt import" --preview http://localhost:3000/import --check "Drop three receipts"
inbox try "The import, step by step" --page "Upload=http://localhost:3000/import" --look "Three receipts listed" \
  --page "Review=http://localhost:3000/import/review" --look "Totals match"
inbox milestone "Lead scene done" --screenshot out/en.png --screenshot out/da.png
inbox activity "Tuning the travel rules" --next "October import end to end"
inbox replies --ack          # replies for this session, marked received
```

To show what changed in the app itself, an agent lines up pages with `--page "Label=URL"` (each optionally followed by `--look "what to look at"`), on any kind of item. You see each page live in a frame and step through them with Next or ← →, the answer below.

Write a decision the way an engineer asks a colleague: the title is the question, the request says what you need and what happens if nobody answers (about 400 characters), the context holds only what matters for choosing, each option is "Label: consequence", and the recommendation is your pick and why. Longer text is accepted; the agent gets a hint.

In the office, agents work together through the same CLI:

```sh
inbox team                   # who am I, my project, my part in it, what waits for me
inbox say Agnes "Can you take the Danish copy?"      # an agent or a team, by name
inbox say founder "On it; the rail lands after the login fix."   # a short answer to you, shown in the office
inbox handoff "Isotope step" --summary "Done in lessons/atoms; check the Danish captions"
inbox review 3f2a9c1e changes --notes "The slider label is still English"
inbox handoff --work 3f2a9c1e --summary "Label translated"   # round 2
P=$(inbox pane)             # a first mate's new pane for a crew member, in a herdr grid
```

A message is typed into each recipient's terminal once herdr reports them free. A handoff goes to the team named with `--to`, or the one the sender's team hands its work to; a team hears it through its lead. Only the receiving team can review, the verdict goes back to whoever handed the work over, and "changes" needs notes. Agents may send 30 messages an hour, so a runaway conversation stops.

`inbox pane [--cwd DIR]` opens a pane in the calling pane's herdr tab and prints its id, so a first mate's crew form a grid (two columns, then two rows each, then the grid grows) rather than a stack. It splits the largest pane of the tab along its longer side, counting a terminal cell as twice as tall as wide, never closes or moves a pane, and does not take focus; `herdr agent start <name> --kind … --pane "$P"` then starts the crew member in it.

Only files named with `--screenshot` are copied: png, jpg, webp, gif, pdf, md and txt files up to 20 MB, never dotfiles.

The CLI finds the calling session from `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` or `HERDR_PANE_ID`, or from `--harness` and `--session`. Posting the same `--key` again revises that item; it does not add a duplicate.

### Pi: live delivery

Add the extension's absolute path to `extensions` in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/path/to/review-inbox/integrations/pi/review-inbox.ts"] }
```

It gives the agent `review_submit` and `review_activity` tools. It also delivers replies into the running session: straight away when Pi is idle, and as a follow-up when Pi is busy. Each reply is acknowledged once Pi has taken it.

### Claude Code: delivery at turn boundaries

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "inbox hook claude" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "inbox hook claude" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "inbox hook claude" }] }]
  }
}
```

Replies arrive when Claude finishes a turn (the hook keeps it going with the reply), when you send a prompt, or when the session starts. A session sitting idle in herdr, which reaches none of those, has the reply typed into its terminal once it is free. If the service is down, the hook does nothing.

### Activity: what they are doing, and their helpers

Optional, and not installed by anything. The office then shows each agent's current tool and its sub-agents. It is kept in memory only, so a restart forgets it.

- **Pi**: the extension above also reports tool calls and finished turns.
- **Claude Code**: add an HTTP hook to `~/.claude/settings.json` (merge with the hooks above):

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4870/api/hooks/claude" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4870/api/hooks/claude" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4870/api/hooks/claude" }] }],
    "Stop": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4870/api/hooks/claude" }] }]
  }
}
```

The endpoint always answers `{}`, so it never changes what Claude does. If the service is down, the hook fails quietly.

### Codex: pull, for now

Codex agents post with the CLI and collect answers with `inbox replies --ack`. The UI tells you that replies wait until the agent asks for them. Two faster routes are candidates but not yet verified: Codex hooks and `codex queue`. See [docs/DESIGN.md](docs/DESIGN.md#codex).

## herdr

If [herdr](https://herdr.dev) is running, the inbox polls `herdr agent list`. It shows each agent's live status and offers **Open conversation**, which focuses that pane. herdr is never the delivery path: without it, everything still works except those two.

## Develop

```sh
npm run typecheck
npm test           # node:test, runs the .ts sources directly
```
