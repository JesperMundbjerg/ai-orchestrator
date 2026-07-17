# Making it a continuous voice interlocutor — design notes

The goal: an AI you can **keep a running conversation with** — talk to it while
you walk around, it answers in a natural voice, it remembers the thread across
hours and days, and it can act on your fleet of coding agents when you ask.
Two jobs in one: a **conversational partner** (fast, natural, always there) and
a **fleet commander** (reads herdr, reads transcripts, dispatches work). Those
two jobs have very different latency and cost profiles, and the main design
decision is whether to serve them with one brain or two.

This doc records the options and a recommended path. Nothing here is built yet
beyond the initial turn-based console (`server.mjs` + `public/index.html`).

---

## 1. The three architectures

### A. Keep the headless Claude Code brain (what we have)
`claude -p --input-format stream-json --output-format stream-json`, one
persistent process, cwd = this repo.

- **+ Fleet tooling is free.** herdr CLI, transcript reading, permission
  allowlist, the persona — all already loaded. The brain *is* an agent.
- **+ Flat cost.** Runs on your Claude Pro/Max subscription; no per-token bill,
  no API key.
- **+ Context/memory managed for you.** Session resume, automatic compaction.
- **− Latency.** It's a full agent loop — thinking, tool discovery, tool
  round-trips — before it answers. Fine for "dispatch an agent," sluggish for
  "hey, what's the weather of the fleet" chit-chat.
- **− You don't control the knobs.** Effort, streaming granularity, caching
  placement are Claude Code's, not yours.

### B. Direct Anthropic Messages API (`/v1/messages`)
You call the model yourself, stream tokens, own the loop.

- **+ Snappy + tunable.** Pick model per turn, `effort: "low"` for chatter,
  stream tokens so TTS starts on the first sentence, place your own prompt-cache
  breakpoints.
- **+ Full memory control.** Compaction, context editing, a memory store — your
  policy.
- **− You rebuild the tools.** Every herdr action becomes a tool you define and
  execute in a tool-use loop. That's the bulk of what Claude Code gives you free.
- **− Per-token billing** and an API key to manage (separate from subscription).

### C. Realtime speech-to-speech, Claude as the brain (bridge pattern)
A realtime voice provider (OpenAI Realtime, Gemini Live, ElevenLabs
Conversational AI, Hume EVI) owns the **ear and mouth** — mic in, voice out,
barge-in, natural turn-taking — but every "what should I say" is delegated to
Claude via a tool/function call.

- **+ Best conversational feel.** Sub-second, interruptible, you can talk over it.
- **+ Hands-free** room-scale, wake-word friendly.
- **− Most moving parts + provider lock-in** for the voice layer.
- **− Bridging latency**: realtime → tool call → Claude → back adds a hop; needs
  care to stay snappy.

**Verdict:** Don't rip out A. Its whole value is that the brain is already an
agent with your fleet tooling and flat cost. The fix for "it's a bit slow to
chat with" is a **two-tier split** (§5), not a rewrite.

---

## 2. Models for long-running talk

Policy for this project: **Opus or Sonnet** (Fable 5 is deliberately out —
overkill and too expensive for continuous chatter). Latency and cost both matter
when you're talking all day.

| Model | $/MTok in/out | Context | Role |
|---|---|---|---|
| **Haiku 4.5** | 1 / 5 | 200K | Ultra-low-latency chatter, wake-word acks, "did you hear me" turns |
| **Sonnet 5** | 3 / 15 (intro 2/10 to 2026-08-31) | 1M | **Default conversational brain** — near-Opus quality, fast, cheap enough for all-day |
| **Opus 4.8** | 5 / 25 | 1M | Escalation for heavy fleet reasoning: "read three transcripts and tell me what changed" |

Notes that matter for talk:
- **Adaptive thinking + low effort** for conversational turns. `effort: "low"`
  means fewer, terser tokens and faster replies. Reserve `high`/`xhigh` for the
  fleet-analysis turns.
- **Fast mode** (Opus 4.8, beta `fast-mode-2026-02-01`, first-party API only)
  runs the same model at up to ~2.5× output tok/s at premium price — worth it if
  a heavy Opus turn needs to *feel* fast. Not available through the subscription
  headless path.
- **Tiered routing**: cheap model for banter, escalate to Opus only when the
  request is actually hard. A one-line intent classifier (or just Haiku deciding
  "do I need to call the fleet tool") is enough to route.

---

## 3. The latency budget (why voice feels slow or snappy)

Natural back-and-forth wants the first audio back in **under ~1 second**. The
turn is a pipeline; optimize each stage and overlap them:

```
  speech ──► STT ──► LLM (stream) ──► sentence chunk ──► TTS (stream) ──► audio
            finalize   TTFT            first "."          first-audio
```

The single biggest win: **don't wait for the whole answer.** Stream LLM tokens,
and the moment you have the first sentence, send it to a **streaming** TTS while
the model keeps generating the rest. First-audio then depends on
`STT-finalize + LLM-TTFT + one-sentence + TTS-first-chunk`, not on the full
response length. This one change makes a turn-based (STT→LLM→TTS) system feel
close to realtime, without provider lock-in.

Architecture A can't do fine-grained sentence chunking today (the headless
result arrives per-turn), which is the concrete latency argument for the
two-tier split.

---

## 4. Voice out — ranked

| Option | Feel | Latency | Notes |
|---|---|---|---|
| **Browser `speechSynthesis`** (current) | robotic, OS-dependent | instant | Free, offline, Chrome/Edge. Fine for a prototype. |
| **Cloud neural TTS, non-streaming** (Azure, Google, Amazon Polly Neural, OpenAI `tts-1`) | natural | high — waits for full audio | Skip for conversation; fine for one-shot readouts. |
| **Streaming neural TTS** (ElevenLabs Flash, Cartesia Sonic, Deepgram Aura, OpenAI streaming, **Grok TTS**, Groq PlayAI/Orpheus) | natural | low first-audio (~tens–low-hundreds ms, verify current) | **The upgrade.** Feed it sentence-by-sentence from the LLM stream (§3). Groq PlayAI/Orpheus run on the captain's existing key — see §10. |
| **Realtime speech-to-speech** (OpenAI Realtime, **Grok Voice Agent**, Gemini Live, ElevenLabs Conversational, Hume EVI) | most natural, interruptible | lowest | Architecture C; owns the whole voice loop, provider lock-in. Grok's is OpenAI-Realtime-compatible with tool use — see §10. |

Voice out **now**: keep `speechSynthesis`. Voice out **next**: streaming neural
TTS, chunked per sentence. (All TTS is third-party — there's no Claude TTS
product; the LLM stays Claude.)

Product specs above are as of early 2026 — verify current latency/pricing before
committing to a vendor.

---

## 5. Recommended path

**Now (pragmatic, small changes to what exists):**
1. Point `ORCHESTRATOR_MODEL` at **Sonnet 5** for snappier turns; keep Opus as
   an opt-in for heavy sessions.
2. Upgrade voice-out to a **streaming neural TTS**, fed sentence-by-sentence.
   Needs the server to surface partial assistant text (Claude Code
   `--include-partial-messages`) so TTS can start before the turn ends.
3. Keep everything else — the herdr tooling and flat-cost subscription brain are
   the point.

**Next (two-tier, when chatter latency still bugs you):**
- **Conversational tier** — Messages API, Sonnet 5 (Haiku for pure banter),
  streaming + prompt caching + low effort. This is what you actually talk to.
- **Fleet tier** — the existing headless Claude Code brain with herdr tooling.
  The conversational tier calls it as a tool when you ask for real fleet work
  ("dispatch," "what did X do," "who's stuck").
- Result: daily talk is cheap and instant; heavy fleet work keeps its full
  agentic power. One intent hop decides which tier handles a turn.

**Later (if you want true hands-free room-scale):** Architecture C for the voice
loop with Claude bridged in as the brain, plus a wake word.

---

## 6. Memory across a continuous relationship

Three layers, each solving a different timescale:

- **Within a turn-heavy session — prompt caching.** Cache the persona/system
  prompt + tool defs + conversation prefix so each turn only pays for new tokens
  (~0.1× on cache reads). Use the 1-hour TTL if you leave gaps. This is the
  difference between an all-day conversation costing cents vs. dollars.
- **Approaching the context window — compaction.** Beta `compact-2026-01-12`
  auto-summarizes older history so a genuinely long thread doesn't fall off the
  edge. (Architecture A already gets Claude Code's compaction for free.)
- **Across days / restarts — a durable memory doc.** Session resume handles a
  process restart, but for a persistent identity ("remember what I care about,
  what the fleet has been doing this week") keep a `fleet/memory.md` the brain
  reads at boot and appends to — mirroring how firstmate routes fleet-wide
  lessons to a `learnings.md`. Robust because it survives even a brand-new
  session.

---

## 7. Voice in / hands-free (walking around the room)

- **Now:** browser Web Speech API — free, good enough, Chrome/Edge desktop, tab
  must be focused. Already built (push-to-talk + open-mic with TTS
  feedback-loop suppression).
- **Room-scale hands-free:** a server-side streaming STT (Deepgram, AssemblyAI,
  Google, Azure) fed by an always-on mic, gated by an **on-device wake word**
  (Picovoice Porcupine) so it isn't transcribing everything you say all day.
- **Phone as the mic:** the Web Speech mic needs **HTTPS** off localhost — put
  the server behind Tailscale or a self-signed cert. (Already on the roadmap.)

---

## 8. Rough cost intuition

- **Architecture A** — flat: your Pro/Max subscription, no metering. Cheapest for
  heavy continuous use, if you can live with the latency.
- **Conversational tier on Sonnet 5** — short turns, heavily cached. A day of
  chat is dominated by cache reads (~0.1×), so realistically single-digit
  dollars/day even at volume; Haiku for banter drops it further.
- **Streaming TTS** — per-character/per-second vendor pricing; usually the
  larger line item than the LLM for a talk-heavy day. Pick the vendor on
  latency + price together.

---

## 9. Decisions for you

1. **One brain or two?** Ship the pragmatic single-brain upgrade first (§5 Now),
   or jump straight to the two-tier split?
2. **Conversational model** — Sonnet 5 as default, Haiku for banter, Opus on
   escalation: agree with that ladder?
3. **TTS vendor** — which streaming TTS to prototype first (ElevenLabs /
   Cartesia / OpenAI / Deepgram)? Latency, voice, and price all differ.
4. **Realtime later, or not at all?** Is barge-in / true hands-free a real
   requirement, or is push-to-talk + open-mic enough?
5. **Cost model** — stay on flat subscription for as long as possible, or accept
   per-token for the conversational snappiness?

---

## 10. Addendum (2026-07-17) — the Grok voice stack, and two brains firmed

### The captain's actual voice-in stack (clarified 2026-07-17)

Voice-in today is **Groq** (GroqCloud — not xAI's Grok): `whisper-large-v3-turbo`
on the on-demand tier, driven by the **Whispering** dictation app. That leg is
settled — fast, accurate, effectively free at this usage. Keep it.

**Voice-out on Groq** (the "can grok models do voice out" answer): yes —
`playai-tts` (PlayAI Dialog, English/Arabic, ~140 chars/s generation, $50/1M
chars on-demand) and the newer **Orpheus** preview models (~100 chars/s,
near-real-time). Decent conversational quality, not ElevenLabs-tier. Two
things to verify in practice before depending on it: free-tier TTS rate limits
(tighter than STT) and whether the voice quality passes the captain's ear.
Same API key and OpenAI-compatible request shapes as the STT already in use —
the lowest-friction voice-out prototype by far.

**The other Grok — xAI** — shipped standalone voice APIs in April 2026; the
alternate/upgrade branch (separate vendor, separate key, NOT the current free
budget):

- **Grok STT** — `POST https://api.x.ai/v1/stt` (batch, ~$0.10/hr) and
  `wss://api.x.ai/v1/stt` (true streaming, ~$0.20/hr), 25 languages.
- **Grok TTS** — `xai/grok-tts`, expressive multilingual voices with speech tags.
- **Grok Voice Agent API** — real-time speech-to-speech over WebSockets with
  low-latency turn-taking **and tool use**, OpenAI-Realtime-compatible
  (`wss://api.x.ai/v1/realtime`, model `grok-voice-think-fast-1.0`). This is
  Architecture C (§1) as a drop-in — the strongest candidate if true barge-in
  hands-free ever becomes a hard requirement.

### Whispering, today

Zero-change integration already works: Whispering pastes the transcript at the
cursor → focus the console's text input → Enter. It bypasses the Web Speech
API entirely (no Chrome dependency for voice-in). The integrated upgrade is
browser mic → server → Groq `whisper-large-v3-turbo` per utterance — Groq's
endpoint is batch, not streaming, but it's fast enough that per-utterance
transcription still feels live for conversation.

### The two brains, named

The captain's framing: one brain orchestrates, one talks "like an engineer I
talk to." Firmed:

- **The Engineer (talking brain)** — natural-language colleague. Fast, warm,
  interruptible. Holds the conversational thread and the relationship memory.
  Does NOT touch the fleet directly.
- **The Foreman (fleet brain)** — the existing headless Claude Code session
  with herdr tooling, subscription-flat. Slow is fine here.
- **The bridge** — the server exposes the Foreman as a tool
  (`fleet(request)` → forwards into the headless session → returns its
  answer). The Engineer calls it whenever the captain asks for real fleet work.
  The bridge is vendor-neutral: any Engineer implementation uses the same tool.

Two Engineer implementations, same bridge:

| | **(a) xAI Grok Voice Agent (realtime)** | **(b) Streamed text tier** |
|---|---|---|
| Pipeline | one WebSocket: speech↔speech + tool calls | Groq whisper-turbo (per utterance) → LLM (stream) → Groq playai/orpheus TTS (sentence-chunked) |
| Talking brain | `grok-voice-think-fast-1.0` | **Sonnet 5** |
| Feel | best: barge-in, instant | near-realtime with sentence streaming |
| Substance | good chat; delegates hard stuff to the Foreman | Sonnet-level dialogue quality |
| Cost | needs an xAI key (separate vendor) | voice legs on the existing Groq key; LLM per-token |

**Recommendation:** build the **bridge first** (no-regret, both options need
it). Then prototype **(b)** for substance — the "engineer colleague" quality
lives or dies on the talking model, and Sonnet 5 with a proper persona doc is
the strongest colleague. Keep **(a)** as a cheap experiment behind the same
bridge — it's OpenAI-Realtime-compatible, so an evening's work — and adopt it
if the hands-free feel outweighs the dialogue-quality gap.

### Revised decision list

1. ~~One brain or two?~~ **Two** — Engineer + Foreman, tool bridge between.
2. Engineer's model: Sonnet 5 (recommended) — revisit only if per-token cost
   grates in practice.
3. Voice legs: Groq whisper-turbo is settled for STT. TTS: prototype Groq
   `playai-tts` / Orpheus on the existing key; verify free-tier limits + voice
   quality; fall back to ElevenLabs/Cartesia only if the ear says no.
4. Realtime (a) vs streamed (b) as the default front end — build b; trial a
   only if barge-in hands-free becomes a real requirement (needs an xAI key).
5. Persona doc for the Engineer (tone, memory file, what it may relay to the
   Foreman unprompted) — needs writing either way.
