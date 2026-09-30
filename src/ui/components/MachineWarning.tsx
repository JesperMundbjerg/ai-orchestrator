import { useEffect, useState } from "react";
import type { HeadlessBrowser, MachineState } from "../../shared/types.ts";
import { api } from "../api.ts";

/**
 * Headless browsers that need a look: together using a lot, too many, or one the office could not
 * close. Forgotten browsers are closed by the office itself; with `note`, a quiet line says how
 * many today. Close asks one browser to quit. Shows nothing while all is well.
 */
export function MachineWarning({ tick, floating = false, note = false }: { tick: number; floating?: boolean; note?: boolean }) {
  const [machine, setMachine] = useState<MachineState | null>(null);
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // An office without the watch (an older service) just shows nothing.
    api.machine().then((m) => live && setMachine(m), () => live && setMachine(null));
    return () => void (live = false);
  }, [tick]);

  if (!machine) return null;
  const closed = note && machine.closedToday > 0 ? <p className="machine-note muted">Closed {machine.closedToday} forgotten {machine.closedToday === 1 ? "browser" : "browsers"} today</p> : null;
  if (!machine.warning) return closed;
  const close = (b: HeadlessBrowser) => {
    setClosing((c) => new Set(c).add(b.pid));
    api.closeBrowser(b.pid).then(() => setError(null), (e: Error) => {
      setError(e.message);
      setClosing((c) => new Set([...c].filter((pid) => pid !== b.pid)));
    });
  };

  return (
    <>
    <section className={`machine-warning${floating ? " floating" : ""}`} role="status" aria-live="polite">
      <strong>{headline(machine)}</strong>
      <ul>
        {machine.browsers.map((b) => (
          <li key={b.pid} className={b.reasons.length ? "flagged" : undefined}>
            <span>
              {b.label} <span className="muted">({details(b)})</span>
            </span>
            <button className="ghost small" disabled={closing.has(b.pid)} onClick={() => close(b)} title={`Asks this browser (process ${b.pid}) to quit, with its pages`}>
              {closing.has(b.pid) ? "Closing…" : "Close"}
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="warn">{error}</p> : null}
    </section>
    {closed}
    </>
  );
}

function headline(m: MachineState): string {
  const why = m.warning!.why;
  if (why.includes("hot")) {
    const cores = Math.max(1, Math.round(m.totalCpu / 100));
    return `Headless browsers are using ${cores} ${cores === 1 ? "core" : "cores"}:`;
  }
  if (why.includes("forgotten")) return "A forgotten headless browser could not be closed:";
  return `${m.browsers.length} headless browsers are running:`;
}

function details(b: HeadlessBrowser): string {
  const minutes = Math.round(b.ageSeconds / 60);
  const age = minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  const parts = [`${b.pages} ${b.pages === 1 ? "page" : "pages"}`, `${b.cpu}%`, age];
  if (b.reasons.includes("forgotten")) parts.push("forgotten");
  return parts.join(", ");
}
