# AI Orchestrator

A single voice-driven "first mate" over a fleet of AI coding agents. You talk, it watches the fleet (running in [herdr](https://herdr.dev) panes) and dispatches work — you never touch a terminal.

Inspired by [firstmate](https://github.com/kunchenguid/firstmate), but built natively on herdr's socket API and Claude Code's headless mode instead of a separate agent runtime.

## What it is

One persistent Claude Code session (the "orchestrator" persona, defined in `CLAUDE.md`) sits between a browser voice console and a fleet of coding agents. You ask it things like "what's the status of the fleet" or "make an agent fix the login bug in fysiklab" by voice; it reads the fleet over the `herdr` CLI, reads full agent transcripts from disk, and dispatches or relays work — logging every dispatch to `fleet/ledger.md`. It is read-only unless you explicitly ask it to act.

## Architecture

```
 Browser (voice console)                Node server                  Fleet
┌───────────────────────┐   SSE/POST   ┌───────────────┐   stdin/out ┌──────────────────────┐
│ Web Speech API (STT)  │ ───────────▶ │  server.mjs    │ ───────────▶│ claude -p             │
│ speechSynthesis (TTS) │ ◀─────────── │ (zero deps)    │ ◀───────────│  --input-format       │
└───────────────────────┘              └───────┬────────┘  stream    │  stream-json           │
                                                │           -json     │  --output-format       │
                                                │                     │  stream-json           │
                                                │                     │ cwd = this repo         │
                                                │                     │ (CLAUDE.md = persona,   │
                                                │                     │  .claude/settings.json  │
                                                │                     │  = permission allowlist)│
                                                │                     └──────────┬──────────────┘
                                                │                                │ herdr CLI
                                                │                                ▼
                                                │                     ┌──────────────────────┐
                                                │                     │ herdr panes (agents)  │
                                                │                     │ one Claude session    │
                                                │                     │ per pane              │
                                                │                     └──────────┬───────────┘
                                                │                                │
                                                ▼                                ▼
                                    fleet/projects.md, fleet/ledger.md   ~/.claude/projects/*/*.jsonl
                                    (read/write by the orchestrator)     (full transcripts, read-only)
```

The browser never talks to `claude` or `herdr` directly — everything goes through `server.mjs`, which keeps one long-lived orchestrator subprocess alive across the whole session (spawned once with `cwd` set to this repo, so this `CLAUDE.md` becomes its system context and `.claude/settings.json` its tool permissions) and streams its output back to the browser over SSE as it talks and acts.

## Quickstart

**Prerequisites**

- Node 18+
- [herdr](https://herdr.dev) running, with at least one agent pane open
- Claude Code installed and logged in via subscription (no API key needed)
- Chrome or Edge, for microphone access (Web Speech API)

**One-time trust step (required)**

Claude Code silently ignores the permission allowlist in `.claude/settings.json` for a repo it hasn't trusted yet — the orchestrator will then prompt for every tool call and hang headless. Before first run, do ONE of:

- Run `claude` interactively once inside this repo and accept the trust dialog, or
- Add `"hasTrustDialogAccepted": true` under `projects["C:/projects/ai-orchestrator"]` in `~/.claude.json`

**Run**

```
npm start
```

Open http://localhost:4870 and grant microphone access.

## Configuration

Environment variables:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4870` | HTTP/SSE port |
| `ORCHESTRATOR_MODEL` | `opus` | `opus` or `sonnet` only — do not point this at premium/high-cost tiers |

## Usage examples

- "What's the status of the fleet?"
- "What did I ask einstein and what did it do?"
- "Make an agent fix the login redirect bug in fysiklab."
- "Any agents stuck?"

## Roadmap

- Blocked-agent watcher wired to herdr notifications (proactive nudge instead of poll-on-ask)
- Phone mic support (needs HTTPS — tailscale or a self-signed cert)
- Fleet status strip in the console UI (no need to ask just to see who's idle)
- Per-task brief files + durable dispatch state, firstmate-style (survive a server restart)
- `/afk` supervision mode (orchestrator watches and only pages you on blocked/done)
