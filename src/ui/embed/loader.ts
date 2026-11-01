// The tiny loader a page includes to get the page-comment widget:
//   <script src="http://localhost:4870/embed/loader.js" data-default-team="TEAM_ID" async></script>
// It adds a "Comment" button that opens the office's widget in an iframe and passes the page's
// context to it with postMessage. No imports: the build emits it as one plain script.
// `window.officeComment.open({ selector, selectedText, openUrl, meta, ... })` opens it with more context.
// The widget relays status changes of this page's comments: listen for "office-comment:status" on
// window (detail: {id, status, openUrl, note, commit, meta}). `watch(ids)` narrows that to some ids.

type Context = { url?: string; title?: string; selector?: string; anchor?: string; selectedText?: string; viewport?: string };
type Extra = { openUrl?: string; meta?: Record<string, unknown> };

(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script?.src) return;
  const office = new URL(script.src).origin;
  const defaultTeamId = script.dataset.defaultTeam || undefined;
  const label = script.dataset.label || "Comment";
  let frame: HTMLIFrameElement | null = null;
  let extra: Context = {};
  let fields: Extra = {};
  let watching: string[] | null = null;
  let screenshots: string[] = [];

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:16px;bottom:64px;width:min(360px,calc(100vw - 32px));height:420px;max-height:calc(100vh - 96px);z-index:2147483646;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);overflow:hidden;display:none;background:#f8faf2";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-expanded", "false");
  button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;font:600 14px system-ui,sans-serif;padding:9px 16px;border-radius:20px;border:0;background:#32613d;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)";

  const context = (): Context => ({
    url: location.href,
    title: document.title,
    anchor: location.hash ? location.hash.slice(1) : undefined,
    selectedText: String(getSelection() ?? "") || undefined,
    viewport: `${innerWidth}x${innerHeight}`,
    ...extra,
  });
  const send = () => {
    frame?.contentWindow?.postMessage({ type: "office-comment:context", version: 1, page: context(), defaultTeamId, screenshots, ...fields }, office);
    frame?.contentWindow?.postMessage({ type: "office-comment:watch", version: 1, ...(watching ? { ids: watching } : {}) }, office);
  };
  // The widget loads with the page (hidden), so status events reach it before anyone opens the panel.
  const ensureFrame = () => {
    if (frame) return;
    frame = document.createElement("iframe");
    frame.src = `${office}/embed/comment`;
    frame.title = "Comment to a team";
    frame.style.cssText = "border:0;width:100%;height:100%";
    panel.append(frame);
  };

  const open = (more: Context & Extra & { screenshots?: string[] } = {}) => {
    const { screenshots: shots, openUrl, meta, ...rest } = more;
    extra = rest;
    fields = { ...(openUrl ? { openUrl } : {}), ...(meta ? { meta } : {}) };
    screenshots = shots ?? [];
    ensureFrame();
    send();
    panel.style.display = "block";
    button.setAttribute("aria-expanded", "true");
  };
  const close = () => { panel.style.display = "none"; button.setAttribute("aria-expanded", "false"); };

  addEventListener("message", (event) => {
    if (event.origin !== office || !frame || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: string; height?: number } | null;
    if (data?.type === "office-comment:ready") send();
    else if (data?.type === "office-comment:resize" && typeof data.height === "number") panel.style.height = `${Math.min(Math.max(data.height, 200), 640)}px`;
    if (data?.type) dispatchEvent(new CustomEvent(data.type, { detail: data }));
  });
  // A selection is lost on click, so it is taken while the button is pressed.
  let selected = "";
  button.addEventListener("pointerdown", () => { selected = String(getSelection() ?? ""); });
  button.addEventListener("click", () => (panel.style.display === "block" ? close() : open(selected ? { selectedText: selected } : {})));

  const watch = (ids?: string[]) => { watching = ids?.length ? ids : null; ensureFrame(); send(); };
  const mount = () => { document.body.append(panel, button); ensureFrame(); };
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);
  (window as unknown as { officeComment: unknown }).officeComment = { open, close, watch };
})();
