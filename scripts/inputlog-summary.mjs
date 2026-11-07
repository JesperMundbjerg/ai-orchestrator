#!/usr/bin/env node
// Read-only: GETs the office's input log (recorded by a tab opened with ?inputlog=1) and prints a
// timeline around each Cmd/Ctrl+V and paste: the events 2 s before and after, and long tasks overlapping.
// Usage: node scripts/inputlog-summary.mjs [--url http://127.0.0.1:4870] [--window 2000] [--json]

const WINDOW_MS = 2000;
const QUIET = new Set(["keydown:bubbled", "keyup:bubbled"]);

/** Meta+V / Ctrl+V keydowns and paste events: the moments worth a look. */
export function isAnchor(e) {
  return e.kind === "paste" || (e.kind === "keydown" && (e.meta || e.ctrl) && (e.code === "KeyV" || String(e.key).toLowerCase() === "v"));
}

const isLong = (e) => e.kind === "longtask" || e.kind === "long-animation-frame";

/** Groups events (one tab's clock each) into windows around anchors; nearby anchors share one window. */
export function windowsAround(events, windowMs = WINDOW_MS) {
  const byTab = new Map();
  for (const e of events) {
    if (typeof e.t !== "number") continue;
    const tab = e.tab ?? "?";
    if (!byTab.has(tab)) byTab.set(tab, []);
    byTab.get(tab).push(e);
  }
  const out = [];
  for (const [tab, list] of byTab) {
    list.sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0));
    let current = null;
    for (const a of list.filter(isAnchor)) {
      if (current && a.t - windowMs <= current.to) { current.to = a.t + windowMs; current.anchors.push(a); continue; }
      current = { tab, from: a.t - windowMs, to: a.t + windowMs, anchors: [a] };
      out.push(current);
    }
    for (const w of out.filter((w) => w.tab === tab)) {
      w.events = list.filter((e) => !isLong(e) && e.t >= w.from && e.t <= w.to);
      // A long task is in the window if any of it overlaps, even when it started before.
      w.longTasks = list.filter((e) => isLong(e) && e.t <= w.to && e.t + (e.duration ?? 0) >= w.from);
    }
  }
  return out.sort((a, b) => a.anchors[0].wall - b.anchors[0].wall);
}

const FIELDS = ["key", "code", "inputType", "dataLength", "valueLength", "selStart", "selEnd", "types", "textLength", "fileCount", "fileTypes", "state", "name", "duration", "waited", "processing", "blocking", "lag", "related"];

/** One line per event, `+ms` relative to the anchor; no text is ever in the log to print. */
export function formatEvent(e, zero) {
  const mods = ["meta", "ctrl", "alt", "shift"].filter((m) => e[m]).join("+");
  const bits = [];
  for (const f of FIELDS) {
    const v = e[f];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    bits.push(`${f}=${Array.isArray(v) ? v.join(",") : v}`);
  }
  if (mods) bits.unshift(mods);
  if (e.repeat) bits.push("repeat");
  if (e.trusted === false) bits.push("UNTRUSTED");
  if (e.defaultPrevented) bits.push("PREVENTED");
  if (e.docFocus === false) bits.push("doc-not-focused");
  const where = e.target ? ` @${e.target}${e.label ? `[${e.label}]` : ""}` : "";
  const rel = Math.round(e.t - zero);
  return `${(rel >= 0 ? "+" : "") + rel}ms`.padStart(9) + `  ${(isAnchor(e) ? "▶ " : "  ") + e.kind}${where}  ${bits.join(" ")}`.trimEnd();
}

export function summarize(log, windowMs = WINDOW_MS) {
  const lines = [`input log: ${log.events.length} events kept (${log.total} received, ${log.dropped} pushed out, capacity ${log.capacity})`];
  const windows = windowsAround(log.events, windowMs);
  if (!windows.length) lines.push("no Cmd/Ctrl+V keydown or paste event recorded");
  for (const w of windows) {
    const zero = w.anchors[0].t;
    lines.push("", `── tab ${w.tab} · ${new Date(w.anchors[0].wall).toISOString()} · ${w.anchors.length} anchor(s) ──`);
    for (const e of w.events) if (!QUIET.has(e.kind) || isAnchor(e)) lines.push(formatEvent(e, zero));
    if (w.longTasks.length) {
      lines.push("  long tasks overlapping:");
      for (const e of w.longTasks) lines.push(formatEvent(e, zero));
    }
    const pastes = w.events.filter((e) => e.kind === "paste");
    const keys = w.anchors.filter((e) => e.kind === "keydown");
    lines.push(`  → ${keys.length} V keydown(s), ${pastes.length} paste(s)${pastes.length ? `, paste text lengths ${pastes.map((p) => p.textLength).join(",")}` : ""}, longest task ${Math.max(0, ...w.longTasks.map((e) => e.duration ?? 0))}ms`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const base = opt("--url", `http://127.0.0.1:${process.env.INBOX_PORT ?? 4870}`);
  const res = await fetch(`${base}/api/debug/inputlog`);
  if (!res.ok) { console.error(`GET ${base}/api/debug/inputlog: ${res.status} ${await res.text()}`); process.exit(1); }
  const log = await res.json();
  console.log(args.includes("--json") ? JSON.stringify(windowsAround(log.events, Number(opt("--window", WINDOW_MS))), null, 2) : summarize(log, Number(opt("--window", WINDOW_MS))));
}
