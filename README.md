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

## Connect an agent

Every harness can use the `inbox` CLI (`npm link` puts it on `PATH`):

```sh
inbox decide "Where should the open tutor sit?" \
  --option "Overlay: covers the right third while open" --option "Docked: the stage narrows instead" \
  --recommend "Docked keeps the slider visible" --screenshot shots/open.png --context "Seen in the isotope step"
inbox try "Try the receipt import" --preview http://localhost:3000/import --check "Drop three receipts"
inbox milestone "Lead scene done" --screenshot out/en.png --screenshot out/da.png
inbox activity "Tuning the travel rules" --next "October import end to end"
inbox replies --ack          # replies for this session, marked received
```

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

Replies arrive when Claude finishes a turn (the hook keeps it going with the reply), when you send a prompt, or when the session starts. If the service is down, the hook does nothing.

### Codex: pull, for now

Codex agents post with the CLI and collect answers with `inbox replies --ack`. The UI tells you that replies wait until the agent asks for them. Two faster routes are candidates but not yet verified: Codex hooks and `codex queue`. See [docs/DESIGN.md](docs/DESIGN.md#codex).

## herdr

If [herdr](https://herdr.dev) is running, the inbox polls `herdr agent list`. It shows each agent's live status and offers **Open conversation**, which focuses that pane. herdr is never the delivery path: without it, everything still works except those two.

## Develop

```sh
npm run typecheck
npm test           # node:test, runs the .ts sources directly
```
