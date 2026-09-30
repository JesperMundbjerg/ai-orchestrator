import { useEffect, useState } from "react";
import type { HeadlessBrowser, MachineState } from "../../shared/types.ts";
import { api } from "../api.ts";

/**
 * Headless browsers agents left running, when they need a look: together using a lot, one
 * outliving its project's work, or too many. Close asks that one browser to quit; the office never
 * closes anything by itself. Shows nothing while all is well.
 */
export function MachineWarning({ tick, floating = false }: { tick: number; floating?: boolean }) {
  const [machine, setMachine] = useState<MachineState | null>(null);
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // An office without the watch (an older service) just shows nothing.
    api.machine().then((m) => live && setMachine(m), () => live && setMachine(null));
    return () => void (live = false);
  }, [tick]);

  if (!machine?.warning) return null;
  const close = (b: HeadlessBrowser) => {
    setClosing((c) => new Set(c).add(b.pid));
    api.closeBrowser(b.pid).then(() => setError(null), (e: Error) => {
      setError(e.message);
      setClosing((c) => new Set([...c].filter((pid) => pid !== b.pid)));
    });
  };

  return (
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
  );
}

function headline(m: MachineState): string {
  const why = m.warning!.why;
  if (why.includes("hot")) {
    const cores = Math.max(1, Math.round(m.totalCpu / 100));
    return `Headless browsers are using ${cores} ${cores === 1 ? "core" : "cores"}:`;
  }
  if (why.includes("forgotten")) return "Headless browsers are running while nobody on their project works:";
  return `${m.browsers.length} headless browsers are running:`;
}

function details(b: HeadlessBrowser): string {
  const minutes = Math.round(b.ageSeconds / 60);
  const age = minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  const parts = [`${b.pages} ${b.pages === 1 ? "page" : "pages"}`, `${b.cpu}%`, age];
  if (b.reasons.includes("forgotten")) parts.push(`nobody working for ${b.idleMinutes} min`);
  return parts.join(", ");
}
