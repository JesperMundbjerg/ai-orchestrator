// Opt-in input recorder for diagnosing dictation (Wispr Flow's synthetic Cmd+V) in the founder's own
// Chrome. Off unless the URL carries `?inputlog=1` (remembered for the tab; `?inputlog=0` forgets it);
// when off it adds nothing. It records timings, keys, input types, lengths and clipboard types, never
// the text itself, and posts batches every 2 s to POST /api/debug/inputlog (memory only on the service).

type Fields = Record<string, string | number | boolean | null | string[]>;
type Rec = Fields & { kind: string; t: number; wall: number; tab: string };

const KEY = "inputlog";
const RING = 2000;

export function inputLogEnabled(): boolean {
  try {
    const q = new URLSearchParams(location.search).get(KEY);
    if (q === "1") sessionStorage.setItem(KEY, "1");
    else if (q === "0") sessionStorage.removeItem(KEY);
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return new URLSearchParams(location.search).get(KEY) === "1";
  }
}

function describe(target: EventTarget | null): Fields {
  if (!(target instanceof Element)) return { target: target === window ? "window" : target === document ? "document" : String(target && (target as object).constructor?.name) };
  const el = target as HTMLElement;
  const out: Fields = { target: el.tagName.toLowerCase() };
  const label = el.getAttribute("aria-label") ?? (el as HTMLInputElement).placeholder ?? null;
  if (label) out.label = label.slice(0, 60);
  if (el.id) out.id = el.id.slice(0, 40);
  if (el.isContentEditable) out.editable = true;
  return out;
}

function boxState(el: Element | null): Fields {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return { valueLength: el.value.length, selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  if (el instanceof HTMLElement && el.isContentEditable) return { valueLength: el.textContent?.length ?? 0 };
  return {};
}

export function startInputLog(): void {
  if (!inputLogEnabled()) return;
  const tab = Math.random().toString(36).slice(2, 8);
  const ring: Rec[] = [];
  let unsent: Rec[] = [];
  let droppedUnsent = 0;
  const record = (kind: string, fields: Fields = {}, t = performance.now()): Rec => {
    const rec: Rec = { kind, t: Math.round(t * 10) / 10, wall: Math.round(performance.timeOrigin + t), tab, ...fields };
    ring.push(rec);
    if (ring.length > RING) ring.shift();
    unsent.push(rec);
    if (unsent.length > RING) { unsent.shift(); droppedUnsent++; }
    return rec;
  };
  // defaultPrevented is read once the event's dispatch is over, whichever handler (or none) called it.
  const after = (rec: Rec, e: Event) => setTimeout(() => { rec.defaultPrevented = e.defaultPrevented; }, 0);
  const opts = { capture: true, passive: true } as const;

  for (const type of ["keydown", "keyup"] as const) {
    window.addEventListener(type, (e) => {
      const rec = record(type, {
        key: e.key.length === 1 && !e.metaKey && !e.ctrlKey ? "char" : e.key, code: e.code,
        meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, repeat: e.repeat, trusted: e.isTrusted,
        docFocus: document.hasFocus(), ...describe(e.target), ...boxState(document.activeElement),
      }, e.timeStamp);
      rec.lag = Math.round(performance.now() - e.timeStamp);
      after(rec, e);
    }, opts);
    // Bubbling at window: whether the key got all the way up (a stopPropagation below would hide it).
    window.addEventListener(type, (e) => { if (e.metaKey || e.ctrlKey) record(`${type}:bubbled`, { code: e.code, defaultPrevented: e.defaultPrevented }, e.timeStamp); });
  }
  for (const type of ["beforeinput", "input"] as const) {
    window.addEventListener(type, (e) => {
      const ie = e as InputEvent;
      const rec = record(type, { inputType: ie.inputType ?? null, dataLength: ie.data?.length ?? null, trusted: e.isTrusted, ...describe(e.target) }, e.timeStamp);
      if (type === "input") Object.assign(rec, boxState(e.target as Element));
      else after(rec, e);
    }, opts);
  }
  window.addEventListener("paste", (e) => {
    const dt = e.clipboardData;
    const files = dt ? [...dt.files] : [];
    const rec = record("paste", {
      types: dt ? [...dt.types] : [], textLength: dt?.getData("text/plain").length ?? null, htmlLength: dt?.getData("text/html").length ?? null,
      fileCount: files.length, fileTypes: files.map((f) => f.type || "?"), trusted: e.isTrusted, docFocus: document.hasFocus(),
      ...describe(e.target), ...boxState(document.activeElement),
    }, e.timeStamp);
    rec.lag = Math.round(performance.now() - e.timeStamp);
    after(rec, e);
  }, opts);
  for (const type of ["compositionstart", "compositionupdate", "compositionend"] as const) {
    window.addEventListener(type, (e) => record(type, { dataLength: (e as CompositionEvent).data?.length ?? null, trusted: e.isTrusted, ...describe(e.target) }, e.timeStamp), opts);
  }
  for (const type of ["focusin", "focusout"] as const) {
    window.addEventListener(type, (e) => record(type, { ...describe(e.target), related: describe((e as FocusEvent).relatedTarget).target ?? null }, e.timeStamp), opts);
  }
  window.addEventListener("focus", (e) => { if (e.target === window) record("window-focus", {}, e.timeStamp); }, opts);
  window.addEventListener("blur", (e) => { if (e.target === window) record("window-blur", {}, e.timeStamp); }, opts);
  document.addEventListener("visibilitychange", (e) => record("visibilitychange", { state: document.visibilityState }, e.timeStamp));
  let lastSel = "";
  document.addEventListener("selectionchange", (e) => {
    const box = boxState(document.activeElement);
    if (box.valueLength === undefined) return;
    const sig = JSON.stringify(box);
    if (sig === lastSel) return;
    lastSel = sig;
    record("selectionchange", { ...describe(document.activeElement), ...box }, e.timeStamp);
  });

  const observe = (type: string, init: PerformanceObserverInit, map: (e: PerformanceEntry) => Fields | null) => {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const f = map(entry);
          if (f) record(type, { start: Math.round(entry.startTime), duration: Math.round(entry.duration), ...f }, entry.startTime);
        }
      }).observe(init);
    } catch { record("observer-unsupported", { type }); }
  };
  observe("longtask", { type: "longtask", buffered: true }, () => ({}));
  observe("long-animation-frame", { type: "long-animation-frame", buffered: true } as PerformanceObserverInit, (e) => {
    const f = e as PerformanceEntry & { blockingDuration?: number };
    return { blocking: Math.round(f.blockingDuration ?? 0) };
  });
  observe("event-timing", { type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit, (e) => {
    const ev = e as PerformanceEntry & { processingStart: number; processingEnd: number; interactionId?: number };
    return { name: e.name, waited: Math.round(ev.processingStart - e.startTime), processing: Math.round(ev.processingEnd - ev.processingStart), interactionId: ev.interactionId ?? 0 };
  });

  const flush = async () => {
    if (!unsent.length) return;
    const batch = unsent;
    unsent = [];
    if (droppedUnsent) { batch.unshift({ kind: "dropped-unsent", t: performance.now(), wall: Date.now(), tab, count: droppedUnsent }); droppedUnsent = 0; }
    try {
      const res = await fetch("/api/debug/inputlog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: batch }), keepalive: batch.length < 200 });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      unsent = [...batch, ...unsent].slice(-RING);
    }
  };
  setInterval(() => void flush(), 2000);
  window.addEventListener("pagehide", () => void flush());

  record("recorder-start", { ua: navigator.userAgent.slice(0, 120), path: location.pathname + location.hash, docFocus: document.hasFocus(), visibility: document.visibilityState });
  (window as unknown as { __inputlog?: Rec[] }).__inputlog = ring;

  const badge = document.createElement("div");
  badge.textContent = "recording input";
  badge.setAttribute("role", "status");
  badge.title = "Input log on for this tab (?inputlog=0 to stop). Records timings and lengths, never text.";
  Object.assign(badge.style, {
    position: "fixed", left: "8px", bottom: "8px", zIndex: "2147483647", pointerEvents: "none",
    font: "600 11px system-ui, sans-serif", padding: "3px 8px", borderRadius: "999px",
    background: "#b42318", color: "#fff", opacity: "0.85",
  });
  const mount = () => document.body.appendChild(badge);
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
