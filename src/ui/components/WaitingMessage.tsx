import { useEffect, useState } from "react";
import type { Message } from "../../shared/types.ts";
import { waitingLabel } from "../../shared/waiting.ts";

/** The age keeps advancing even if neither presence nor the thread changes. */
export function WaitingMessage({ message, agentId }: { message: Message; agentId?: string }) {
  const [now, setNow] = useState(Date.now);
  const queued = !message.fromAgentId && !message.fromOffice && message.deliveries.some((d) => d.state === "queued");
  useEffect(() => {
    if (!queued) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [queued]);
  const labels = message.deliveries.filter((d) => !agentId || d.agentId === agentId).flatMap((d) => waitingLabel(message, d, now) ?? []);
  return labels.length ? <div className="warn small-note" role="status">{[...new Set(labels)].join(" · ")}</div> : null;
}
