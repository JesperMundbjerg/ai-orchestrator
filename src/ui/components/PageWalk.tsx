import { useEffect, useState } from "react";
import { pageName } from "../../shared/pages.ts";
import type { Page, PageCheck, Preview } from "../../shared/types.ts";
import { api } from "../api.ts";

/** How long a page may take to load before you are offered the tab instead. */
const SLOW_MS = 12_000;

/**
 * The pages an agent lined up, one live frame at a time: Previous and Next (or ← →) step
 * through them. A page that is down or will not be framed says so, with the link, rather than
 * leaving an empty box. The answer stays below, so you can answer from any page.
 */
export function PageWalk({ itemId, pages, viewport, setup }: { itemId: string; pages: Page[]; viewport: Preview["viewport"]; setup: string }) {
  const [at, setAt] = useState(0);
  const index = Math.min(at, pages.length - 1);
  const page = pages[index]!;
  const [checks, setChecks] = useState<Record<number, PageCheck>>({});
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const check = checks[index];

  const go = (step: number) => setAt((i) => Math.max(0, Math.min(pages.length - 1, i + step)));

  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    // The frame waits for the check, so a page that refuses framing never flashes a broken box.
    // If the check itself fails, the frame is tried anyway.
    const unknown: PageCheck = { reachable: true, status: null, framable: null, checkedAt: "" };
    if (!checks[index]) api.checkPage(itemId, index).then((c) => setChecks((all) => ({ ...all, [index]: c })), () => setChecks((all) => ({ ...all, [index]: unknown })));
    return () => clearTimeout(timer);
  }, [itemId, index, page.url]);

  // ← and → step through the pages, unless you are typing. Caught before the office's own
  // keys, so flipping a page does not also turn you round.
  useEffect(() => {
    if (pages.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      e.stopPropagation();
      go(e.key === "ArrowRight" ? 1 : -1);
    };
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
  }, [pages.length]);

  const open = (
    <a href={page.url} target="_blank" rel="noreferrer">Open in a new tab ↗</a>
  );
  const problem = !check ? null
    : !check.reachable ? `This page is not answering${check.status ? ` (${check.status})` : ""}; the server may be stopped.`
    : check.framable === false ? "This page does not allow being shown inside another page."
    : null;
  // A page from the office's own origin gets no same-origin rights, so it cannot reach the office.
  const ownOrigin = new URL(page.url, location.href).origin === location.origin;

  return (
    <div className="walk">
      <div className="walk-bar">
        {pages.length > 1 ? <button className="ghost small" disabled={index === 0} onClick={() => go(-1)} title="Previous page (←)">← Previous</button> : null}
        <div className="walk-title">
          <strong>{pageName(page)}</strong>
          {pages.length > 1 ? <span className="muted"> · {index + 1} of {pages.length}</span> : null}
        </div>
        {pages.length > 1 ? <button className="primary small" disabled={index === pages.length - 1} onClick={() => go(1)} title="Next page (→)">Next →</button> : null}
        <span className="walk-open">{open}</span>
      </div>
      {page.look ? <p className="walk-look"><span className="muted">Look at:</span> {page.look}</p> : null}
      {setup && index === 0 ? <p className="muted small-note">Setup: {setup}</p> : null}
      {!check ? (
        <p className="walk-fallback">Loading the page…</p>
      ) : problem ? (
        <p className="walk-fallback">{problem} {open}</p>
      ) : (
        <div className={`walk-stage ${viewport ?? "desktop"}`}>
          {!loaded ? <p className="walk-fallback over">{slow ? <>This page has not loaded yet. {open}</> : "Loading the page…"}</p> : null}
          <iframe
            key={`${index}:${page.url}`}
            className={`frame ${viewport ?? "desktop"}`}
            src={page.url}
            title={pageName(page)}
            sandbox={`allow-scripts allow-forms allow-popups allow-modals allow-downloads${ownOrigin ? "" : " allow-same-origin"}`}
            onLoad={() => setLoaded(true)}
          />
        </div>
      )}
      <p className="muted small-note">Live pages: they show the app as it is now{pages.length > 1 ? " · ← → to step through" : ""}.</p>
    </div>
  );
}
