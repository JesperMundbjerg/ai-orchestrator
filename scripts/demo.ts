// Seeds the inbox with three projects through the agent protocol, exactly as agents would, then
// keeps running as the Pi agent of the first project: it serves a small "accounts" page for the
// try-it item and listens live for replies, printing each one as the agent would receive it.
//
//   npm start        # in one terminal
//   npm run demo     # in another; Ctrl-C ends the pretend agent

import { createServer } from "node:http";
import { join } from "node:path";
import { acknowledge, call, fetchReplies, formatReply } from "../src/shared/agent-client.ts";
import type { SessionInput, SubmitInput, SubmitResult } from "../src/shared/types.ts";

const assets = join(import.meta.dirname, "demo-assets");
const shot = (file: string, caption: string, sourceRevision = "") => ({ path: join(assets, file), caption, sourceRevision });
const PREVIEW_PORT = 4873;

const voice: SessionInput = { harness: "pi", sessionId: "demo-pi-voice-teacher" };
const accounts: SessionInput = { harness: "codex", sessionId: "demo-codex-accounts" };
const story: SessionInput = { harness: "claude", sessionId: "demo-claude-storyboard" };

const submissions: SubmitInput[] = [
  {
    session: voice,
    project: { name: "Fysik Lab", root: "/demo/fysiklab", objective: "Interactive physics lessons with a voice teacher" },
    task: { title: "Voice teacher", objective: "The tutor can talk a student through a lesson without covering the experiment" },
    item: {
      key: "tutor-placement",
      type: "decide",
      title: "Where should the open tutor sit on desktop?",
      request: "Pick where the tutor panel opens. I will build that one and hold the other.",
      context:
        "Today the tutor opens over the right third of the stage. In the isotope step that hides the neutron slider the tutor is pointing at.\n\nBoth screenshots are from the same beat of Atoms and light.",
      recommendation: "B: a docked column keeps the slider visible and costs 12% of stage width only while the tutor is open.",
      options: [
        { id: "a", label: "Overlay (today)", consequence: "No layout change; the tutor covers the right third of the stage while open." },
        { id: "b", label: "Docked column", consequence: "The stage narrows while the tutor is open; nothing is covered." },
      ],
      evidence: [shot("tutor-closed.jpg", "Tutor closed: the whole stage", "3f2a91c"), shot("tutor-open.jpg", "Tutor open as an overlay", "3f2a91c")],
    },
  },
  {
    session: accounts,
    project: { name: "Accounts", root: "/demo/accounts", objective: "Monthly bookkeeping without the spreadsheet" },
    task: { title: "Receipt import", objective: "Drop a folder of receipts and get categorised lines" },
    item: {
      key: "import-preview",
      type: "try",
      title: "Try the receipt import with September's folder",
      request: "Drop the three sample receipts on the page and check the categories look right.",
      context: "The categoriser is rule-based for now. Anything below 60% confidence lands in \"Check me\" instead of guessing.",
      check: "Drop the receipts. The grocery receipt should land in Food, the train ticket in Travel, and the unclear one in Check me.",
      preview: { url: `http://127.0.0.1:${PREVIEW_PORT}/`, viewport: "desktop", setup: "Sample receipts are in ~/Accounts/samples/september" },
      blocking: false,
    },
  },
  {
    session: story,
    project: { name: "Motion video", root: "/demo/motion-video", objective: "A 57 s hero video built from real app footage" },
    task: { title: "Storyboard", objective: "Every scene uses real footage and the app's own copy" },
    item: {
      key: "milestone-lead-scene",
      type: "milestone",
      title: "Lead-thickness scene is done in both languages and both cuts",
      request: "Accept the scene, or say what should change before I render the masters.",
      context:
        "The slider replays the filmed take, so every number on screen is the one the footage shows. The formula chip is gone: the slider and the counter are enough to follow.\n\nChecked at 16:9 and 4:3, English and Danish.",
      evidence: [
        shot("lead-en-16x9.jpg", "English, 16:9, at 15 mm", "motion-video@36s"),
        shot("lead-da-4x3.jpg", "Danish, 4:3, at 5 mm", "motion-video@33s"),
        shot("wall-en-16x9.jpg", "The scene before: the card wall", "motion-video@12s"),
      ],
    },
  },
];

for (const s of submissions) {
  const r = await call<SubmitResult>("/api/agent/items", s);
  console.log(`${r.changed ? "submitted" : "unchanged"}  ${s.item.type.padEnd(9)} ${s.item.title}  (revision ${r.revision})`);
}
await call("/api/agent/activity", { session: voice, activity: "Measuring how often the tutor covers the control it points at", nextMilestone: "Docked tutor on desktop" });
await call("/api/agent/activity", { session: accounts, activity: "Tuning the travel rules", nextMilestone: "October import end to end" });
await call("/api/agent/activity", { session: story, activity: "Waiting for the milestone review", nextMilestone: "Masters rendered" });

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Receipt import</title><body style="font:16px system-ui;margin:40px;color:#222">
<h1 style="font-size:22px">Receipt import</h1><div style="border:2px dashed #aab;border-radius:12px;padding:60px;text-align:center;color:#667">Drop receipts here</div>
<table style="margin-top:24px;border-collapse:collapse;width:100%"><tr><th align=left>Receipt</th><th align=left>Category</th></tr>
<tr><td>Netto 12/09</td><td>Food</td></tr><tr><td>DSB 14/09</td><td>Travel</td></tr><tr><td>IMG_2231.jpg</td><td><b>Check me</b></td></tr></table></body>`);
}).listen(PREVIEW_PORT, "127.0.0.1");

console.log(`\nServing the accounts preview on http://127.0.0.1:${PREVIEW_PORT}/`);
console.log("Listening live as the Voice teacher's Pi agent. Answer its decision in the inbox; Ctrl-C to stop.\n");

const sent = new Set<string>();
setInterval(async () => {
  try {
    for (const r of await fetchReplies(voice, "live")) {
      if (!sent.has(r.deliveryId)) console.log(`${formatReply(r)}\n`);
      sent.add(r.deliveryId);
      await acknowledge(voice, r.deliveryId);
    }
  } catch (e) {
    console.error(`inbox unreachable: ${(e as Error).message}`);
  }
}, 2000);
