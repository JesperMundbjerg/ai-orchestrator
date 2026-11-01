// The page-comment widget, served by the office at /embed/comment on its own origin. A host page
// frames it (or the loader does) and passes page context with postMessage; the widget accepts that
// only from a page origin the founder allowed, and its own requests to the office are same-origin,
// so the office's Origin guard never has to make an exception for another site.
// Opened on its own (not framed), it shows the founder the allowed page origins to edit.
// The host page may also act on its own comments through it (edit, withdraw, answer, send a group);
// the widget checks that each comment was made on the host's origin before it asks the office.

import "./comment.css";
import {
  acceptEmbedMessage, commentEvent, pageContextLines, CLOSED_COMMENT_STATUSES, EMBED_VERSION, KIND_MAX, SUGGESTED_KINDS,
  type AcceptedEmbedMessage, type EmbedOutMessage, type PageCommentEvent, type PageComment, type PageContext, type PageTeam,
} from "../../shared/pagecomments.ts";

const root = document.getElementById("comment")!;
const framed = window.parent !== window;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

async function api<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(path, init ? { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : undefined);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((out as { error?: string }).error ?? `request failed (${res.status})`);
  return out as T;
}

/** The host page this widget talks to, once one of its messages was accepted. */
let host: string | null = null;
let page: PageContext = {};
let openUrl: string | undefined;
let meta: Record<string, unknown> | undefined;
let presetKind: string | undefined;
let hostShots: string[] = [];
/** The status stream relayed to the host: every comment from its origin (ids null), or only these. */
let stream: { source: EventSource; ids: string[] | null } | null = null;
let onStatus: (event: PageCommentEvent) => void = () => {};
/** Comments on the host's origin this widget has heard of, by id: questions are answered from here. */
const known = new Map<string, PageCommentEvent>();

/** Relays status changes of the host origin's comments to the host; the office filters by that origin, so ids cannot reach another page's comments. */
function watch(ids: string[] | null): void {
  if (!host) return;
  stream?.source.close();
  const q = new URLSearchParams({ origin: host });
  if (ids) q.set("ids", ids.join(","));
  const source = new EventSource(`/api/page-comments/events?${q}`);
  source.addEventListener("comment", (e) => {
    const event = JSON.parse((e as MessageEvent<string>).data) as PageCommentEvent;
    known.set(event.id, event);
    onStatus(event);
    post({ type: "office-comment:status", version: EMBED_VERSION, ...event });
  });
  stream = { source, ids };
}
let allowlist: string[] = [];

function post(message: EmbedOutMessage): void {
  if (!framed) return;
  if (message.type === "office-comment:ready") window.parent.postMessage(message, "*");
  else if (host) window.parent.postMessage(message, host);
}

const rememberKey = (origin: string | null) => `office-comment:team:${origin ?? "office"}`;
const remembered = (origin: string | null) => { try { return localStorage.getItem(rememberKey(origin)); } catch { return null; } };
const remember = (origin: string | null, teamId: string) => { try { localStorage.setItem(rememberKey(origin), teamId); } catch { /* storage may be blocked in a frame */ } };

function teamLabel(t: PageTeam): string {
  const lead = t.lead ? (t.lead.online ? `${t.lead.name}, online` : `${t.lead.name}, offline`) : "no lead";
  return `${t.name} (${lead})`;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("could not read the image"));
    r.readAsDataURL(file);
  });
}

async function commentForm(): Promise<void> {
  const [{ teams }, origins] = await Promise.all([
    api<{ teams: PageTeam[] }>("/api/page-comments/teams"),
    api<{ origins: string[] }>("/api/page-comments/origins"),
  ]);
  allowlist = origins.origins;

  const select = el("select", { name: "team", id: "team" });
  for (const t of teams) select.append(el("option", { value: t.id }, teamLabel(t)));
  const note = el("div", { className: "team-note" });
  const textarea = el("textarea", { name: "text", id: "text", placeholder: "What should the team know about this page?" });
  const kindInput = el("input", { type: "text", name: "kind", id: "kind", maxLength: KIND_MAX, placeholder: SUGGESTED_KINDS.join(", ") });
  kindInput.setAttribute("list", "kinds");
  const kinds = el("datalist", { id: "kinds" }, ...SUGGESTED_KINDS.map((k) => el("option", { value: k })));
  const questions = el("section", { className: "questions", hidden: true });
  const groupRow = el("div", { className: "row group", hidden: true });
  const context = el("div", { className: "context", hidden: true });
  const thumbs = el("ul", { className: "thumbs" });
  const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true, className: "attach" });
  file.setAttribute("aria-label", "Attach images");
  const status = el("div", { className: "status", role: "status" });
  const send = el("button", { type: "submit", className: "primary" }, "Send");
  const addToGroup = el("button", { type: "button", className: "add-group" }, "Add to group");
  const withdrawLast = el("button", { type: "button", className: "link", hidden: true }, "Withdraw");
  const form = el("form",
    {},
    el("label", {}, "Team", select), note,
    context,
    el("label", {}, "Comment", textarea),
    el("label", {}, "Kind (optional)", kindInput), kinds,
    thumbs,
    el("div", { className: "row" }, file, el("span", { className: "buttons" }, addToGroup, send)),
    groupRow,
    el("div", { className: "row" }, status, withdrawLast),
  );
  form.style.display = "contents";
  root.replaceChildren(el("h1", {}, "Comment to a team"), questions, form);

  if (!teams.length) {
    select.disabled = true; send.disabled = true; addToGroup.disabled = true;
    note.textContent = "The office has no teams yet.";
  }
  let images: string[] = [];
  let last: { id: string; teamName: string } | null = null;
  /** The group being collected here: held in the office until it is sent. */
  let group: { id: string; teamId: string; teamName: string; count: number } | null = null;
  const STATUS_WORDS: Record<string, string> = {
    held: "held in the group", queued: "queued", delivered: "delivered to the lead", working: "being worked on", asked: "the lead has a question",
    fixed: "fixed", declined: "declined", withdrawn: "withdrawn", failed: "not delivered",
  };
  const showLast = (event: PageCommentEvent) => {
    if (!last) return;
    status.className = event.status === "failed" || event.status === "declined" ? "status error" : "status ok";
    status.textContent = `Sent to ${last.teamName}: ${STATUS_WORDS[event.status] ?? event.status}${event.note ? ` (${event.note})` : ""}.`;
    withdrawLast.hidden = CLOSED_COMMENT_STATUSES.includes(event.status);
  };
  const showGroup = () => {
    groupRow.hidden = !group;
    if (!group) return groupRow.replaceChildren();
    const g = group;
    groupRow.replaceChildren(
      el("span", { className: "muted" }, `${g.count} held for ${g.teamName}`),
      el("span", { className: "buttons" },
        el("button", { type: "button", onclick: () => void groupAction("discard") }, "Discard"),
        el("button", { type: "button", className: "primary", onclick: () => void groupAction("send") }, `Send group (${g.count})`)),
    );
  };
  const groupAction = async (action: "send" | "discard") => {
    if (!group) return;
    const g = group;
    try {
      const out = await api<{ comments: PageComment[] }>(`/api/page-comments/groups/${g.id}/${action}`, { method: "POST", body: {} });
      group = null; showGroup();
      status.className = "status ok";
      status.textContent = action === "send" ? `Sent ${out.comments.length} as one group to ${g.teamName}.` : "The group was discarded.";
      if (action === "send") for (const c of out.comments) post({ type: "office-comment:sent", version: EMBED_VERSION, id: c.id, teamId: c.teamId, teamName: c.teamName, status: c.status });
    } catch (err) { status.className = "status error"; status.textContent = (err as Error).message; }
  };
  /** Open questions from the lead about this page's comments, each with an answer box. */
  const showQuestions = () => {
    const open = [...known.values()].filter((e) => e.status === "asked" && e.question);
    questions.hidden = !open.length;
    questions.replaceChildren(...open.map((e) => {
      const area = el("textarea", { className: "answer", placeholder: "Your answer" });
      area.setAttribute("aria-label", `Answer to ${e.teamName}`);
      const done = el("div", { className: "status", role: "status" });
      const reply = el("button", { type: "button", className: "primary" }, "Answer");
      reply.addEventListener("click", async () => {
        if (!area.value.trim()) return;
        reply.disabled = true;
        try { await api(`/api/page-comments/${e.id}/answer`, { method: "POST", body: { text: area.value } }); }
        catch (err) { done.className = "status error"; done.textContent = (err as Error).message; reply.disabled = false; }
      });
      return el("div", { className: "question" },
        el("div", {}, el("b", {}, `${e.teamName} asks`), ` about “${e.text.slice(0, 80)}${e.text.length > 80 ? "…" : ""}”:`),
        el("p", {}, e.question!), area, el("div", { className: "row" }, done, reply));
    }));
  };
  onStatus = (event) => {
    if (event.id === last?.id) showLast(event);
    showQuestions();
  };
  withdrawLast.addEventListener("click", async () => {
    if (!last) return;
    try { await api(`/api/page-comments/${last.id}/withdraw`, { method: "POST", body: {} }); }
    catch (err) { status.className = "status error"; status.textContent = (err as Error).message; }
  });
  let clientId = crypto.randomUUID();

  const pick = (preferred?: string) => {
    // The last team for this page origin, else the page's default, else the first team with a lead.
    const want = [remembered(host), preferred, teams.find((t) => t.lead)?.id].find((id) => id && teams.some((t) => t.id === id));
    if (want) select.value = want;
    showNote();
  };
  const showNote = () => {
    const t = teams.find((x) => x.id === select.value);
    note.textContent = !t ? "" : [t.purpose, !t.lead ? "No lead: the comment goes to its crew, if it has any." : t.leadPresent ? null : "The lead is not online; the comment waits in the team's queue."].filter(Boolean).join(" · ");
  };
  const showContext = () => {
    const lines = pageContextLines(page);
    context.hidden = !lines.length;
    context.replaceChildren(...lines.flatMap((line, i) => (i ? [el("br"), line] : [line])));
  };
  const showThumbs = () => {
    thumbs.replaceChildren(...images.map((id) => el("li", {},
      el("img", { src: `/uploads/${id}`, alt: "Attached image" }),
      el("button", { type: "button", onclick: () => { images = images.filter((x) => x !== id); clientId = crypto.randomUUID(); showThumbs(); } }, "×"),
    )));
  };
  const upload = async (dataUrl: string) => {
    const { id } = await api<{ id: string }>("/api/uploads", { method: "POST", body: { data: dataUrl } });
    if (!images.includes(id)) images = [...images, id].slice(0, 8);
    clientId = crypto.randomUUID();
    showThumbs();
  };

  select.addEventListener("change", () => { remember(host, select.value); clientId = crypto.randomUUID(); showNote(); });
  textarea.addEventListener("input", () => { clientId = crypto.randomUUID(); });
  kindInput.addEventListener("input", () => { clientId = crypto.randomUUID(); });
  file.addEventListener("change", async () => {
    try { for (const f of file.files ?? []) await upload(await readFile(f)); status.className = "status"; status.textContent = ""; }
    catch (err) { status.className = "status error"; status.textContent = (err as Error).message; }
    file.value = "";
  });
  /** Sends the form's comment now, or (hold) adds it to the group being collected; a held group goes along with Send. */
  const submit = async (hold: boolean) => {
    if (!select.value) return;
    if (group && group.teamId !== select.value) {
      status.className = "status error"; status.textContent = `The group is for ${group.teamName}: send or discard it first.`;
      return;
    }
    send.disabled = true; addToGroup.disabled = true;
    status.className = "status"; status.textContent = hold ? "Adding…" : "Sending…";
    try {
      // The same client id on a retry after a lost answer sends nothing twice.
      const kind = kindInput.value.trim();
      const out = await api<PageComment>(`/api/page-comments/teams/${encodeURIComponent(select.value)}/comments`, {
        method: "POST", body: {
          text: textarea.value, page, images, clientId, ...(openUrl ? { openUrl } : {}), ...(meta ? { meta } : {}), ...(kind ? { kind } : {}),
          ...(group ? { groupId: group.id } : {}), ...(hold ? { hold: true } : {}),
        },
      });
      remember(host, out.teamId);
      textarea.value = ""; kindInput.value = presetKind ?? ""; images = []; showThumbs(); clientId = crypto.randomUUID();
      if (hold) {
        group = { id: out.groupId!, teamId: out.teamId, teamName: out.teamName, count: (group?.count ?? 0) + 1 };
        status.className = "status ok"; status.textContent = `Added to the group for ${out.teamName}.`;
      } else {
        const sentGroup = group;
        group = null;
        last = { id: out.id, teamName: out.teamName };
        showLast(commentEvent(out));
        if (sentGroup) status.textContent = `Sent ${sentGroup.count + 1} as one group to ${out.teamName}.`;
      }
      showGroup();
      if (!hold) post({ type: "office-comment:sent", version: EMBED_VERSION, id: out.id, teamId: out.teamId, teamName: out.teamName, status: out.status });
      // The host hears this comment's progress even if it never asked to watch.
      if (host && (!stream || stream.ids)) watch([...(stream?.ids ?? []), out.id]);
    } catch (err) {
      status.className = "status error"; status.textContent = (err as Error).message;
      post({ type: "office-comment:error", version: EMBED_VERSION, error: (err as Error).message });
    } finally { send.disabled = !teams.length; addToGroup.disabled = !teams.length; }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); void submit(false); });
  addToGroup.addEventListener("click", () => void submit(true));

  /** A host page acting on one of its own comments: only one made on the host's origin. */
  const act = async (accepted: Exclude<AcceptedEmbedMessage, { type: "context" } | { type: "watch" }>) => {
    const reply = (out: { ok: true; comments: PageCommentEvent[] } | { ok: false; error: string }) =>
      post({ type: "office-comment:result", version: EMBED_VERSION, requestId: accepted.requestId, action: accepted.type, ...out });
    try {
      if (accepted.type === "send-group") {
        const teamId = accepted.teamId ?? select.value;
        if (!teamId) throw new Error("no team to send to");
        const out = await api<{ comments: PageComment[] }>(`/api/page-comments/teams/${encodeURIComponent(teamId)}/groups`, {
          method: "POST", body: { comments: accepted.comments.map((c) => ({ ...c, page: { ...page, ...c.page } })), ...(accepted.clientId ? { clientId: accepted.clientId } : {}) },
        });
        if (host && (!stream || stream.ids)) watch([...(stream?.ids ?? []), ...out.comments.map((c) => c.id)]);
        return reply({ ok: true, comments: out.comments.map(commentEvent) });
      }
      const current = await api<PageComment>(`/api/page-comments/${accepted.id}`);
      if (current.origin !== host) throw new Error(`comment ${accepted.id} was not made on this page's origin`);
      const path = `/api/page-comments/${accepted.id}/${accepted.type}`;
      if (accepted.type === "verify") {
        // Still wrong opens a follow-up: the host hears both, the checked comment first.
        const out = await api<{ comment: PageComment; followUp: PageComment | null }>(path, { method: "POST", body: { verdict: accepted.verdict, ...(accepted.note ? { note: accepted.note } : {}) } });
        if (out.followUp && host && stream?.ids) watch([...stream.ids, out.followUp.id]);
        return reply({ ok: true, comments: [out.comment, ...(out.followUp ? [out.followUp] : [])].map(commentEvent) });
      }
      const body = accepted.type === "edit" ? accepted.edit : accepted.type === "answer" ? { text: accepted.text } : (accepted.note ? { note: accepted.note } : {});
      const out = await api<PageComment>(path, { method: "POST", body });
      reply({ ok: true, comments: [commentEvent(out)] });
    } catch (err) { reply({ ok: false, error: (err as Error).message }); }
  };

  window.addEventListener("message", (event) => {
    if (!framed || event.source !== window.parent) return;
    const accepted = acceptEmbedMessage(event.origin, event.data, allowlist);
    if (!accepted) {
      if ((event.data as { type?: unknown } | null)?.type === "office-comment:context") {
        status.className = "status error";
        status.textContent = `This page (${event.origin}) is not allowed to pass page context. The founder can allow it at the office's /embed/comment.`;
      }
      return;
    }
    // The first accepted origin is the host for the widget's life: another origin cannot take it over.
    if (host && host !== event.origin) return;
    host = event.origin;
    if (accepted.type === "watch") return watch(accepted.ids);
    if (accepted.type !== "context") return void act(accepted);
    page = accepted.page;
    openUrl = accepted.openUrl;
    meta = accepted.meta;
    hostShots = accepted.screenshots;
    presetKind = accepted.kind;
    if (presetKind && !kindInput.value) kindInput.value = presetKind;
    showContext();
    pick(accepted.defaultTeamId);
    void (async () => {
      try { for (const s of hostShots) await upload(s); hostShots = []; }
      catch (err) { status.className = "status error"; status.textContent = (err as Error).message; }
    })();
  });

  pick();
  new ResizeObserver(() => post({ type: "office-comment:resize", version: EMBED_VERSION, height: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
  post({ type: "office-comment:ready", version: EMBED_VERSION });
  // Framed, it may load before anyone opens it, so it does not take the page's focus.
  if (!framed) textarea.focus();
}

async function originsForm(): Promise<void> {
  const current = await api<{ origins: string[]; default: boolean }>("/api/page-comments/origins");
  const area = el("textarea", { name: "origins", id: "origins", value: current.origins.join("\n") });
  const status = el("div", { className: "status", role: "status" }, current.default ? "Local dev servers are allowed until you save a list." : "");
  const save = el("button", { type: "button", className: "primary" }, "Save");
  save.addEventListener("click", async () => {
    try {
      const out = await api<{ origins: string[] }>("/api/page-comments/origins", { method: "PUT", body: { origins: area.value.split(/\s+/).filter(Boolean) } });
      area.value = out.origins.join("\n");
      status.className = "status ok"; status.textContent = "Saved.";
    } catch (err) { status.className = "status error"; status.textContent = (err as Error).message; }
  });
  root.append(el("section", { className: "origins" },
    el("h1", {}, "Pages allowed to host this widget"),
    el("label", {}, "One origin per line: scheme://host, scheme://host:port or scheme://host:*", area),
    el("div", { className: "row" }, status, save),
  ));
}

void (async () => {
  try {
    await commentForm();
    if (!framed) await originsForm();
  } catch (err) {
    root.replaceChildren(el("p", { className: "status error" }, `The office could not be reached: ${(err as Error).message}`));
  }
})();
