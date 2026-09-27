import { useCallback, useEffect, useState } from "react";
import type { InboxState, ItemDetail } from "../shared/types.ts";
import { api } from "./api.ts";

/** Bumps whenever the service reports a change, so views refetch what they show. */
export function useChangeSignal(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("changed", () => setTick((t) => t + 1));
    source.onopen = () => setTick((t) => t + 1); // catch up after a reconnect
    return () => source.close();
  }, []);
  return tick;
}

export function useInboxState(tick: number): { state: InboxState | null; error: string | null } {
  const [state, setState] = useState<InboxState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.state().then(
      (s) => live && (setState(s), setError(null)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [tick]);
  return { state, error };
}

export function useItemDetail(itemId: string | null, tick: number): ItemDetail | null {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  useEffect(() => {
    if (!itemId) return setDetail(null);
    let live = true;
    api.detail(itemId).then((d) => live && setDetail(d), () => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [itemId, tick]);
  return detail?.item.id === itemId ? detail : null;
}

export type View = "needs" | "working" | "parked";
export interface Route {
  view: View;
  itemId: string | null;
  projectId: string | null;
}

function parse(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const view = (["needs", "working", "parked"] as const).find((v) => v === path) ?? "needs";
  return { view, itemId: params.get("item"), projectId: params.get("project") };
}

/** The address bar holds the view, the open item and the project filter, so a reload lands in place. */
export function useRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((next: Partial<Route>) => {
    const r = { ...parse(location.hash), ...next };
    const params = new URLSearchParams();
    if (r.itemId) params.set("item", r.itemId);
    if (r.projectId) params.set("project", r.projectId);
    const q = params.toString();
    location.hash = `/${r.view}${q ? `?${q}` : ""}`;
  }, []);
  return [route, navigate];
}
