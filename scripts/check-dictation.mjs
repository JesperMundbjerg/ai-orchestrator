// Headless check that dictated text reaches the office's chat boxes in each way a dictation app
// puts it there (paste, insertText, typing, input-method composition, a value set with or without an
// input event), while the office keeps changing; focus and the box's accessibility node must hold.
// Disposable in-process office: no herdr, account reads or live data.
// npm run build && PLAYWRIGHT_MODULE=/abs/playwright/index.mjs node scripts/check-dictation.mjs
// DICTATION_REPORT_ONLY=1 prints the table without failing; DICTATION_AX=1 also prints the AX chain.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.DICTATION_SCREENSHOTS || join(homedir(), '.review-inbox/handoffs/agent-office/dictation');
const home = mkdtempSync(join(tmpdir(), 'office-dictation-'));
process.env.HOME = home; process.env.INBOX_DATA_DIR = join(home, 'data');
process.env.HERDR_SOCKET_PATH = '/nonexistent'; process.env.HERDR_BIN_PATH = '/usr/bin/false';
for (const k of ['INBOX_CODEX_ACCOUNT_POLLING', 'INBOX_PRESENCE_DISCOVERY', 'INBOX_BROWSER_CLEANUP']) process.env[k] = '0';
const { openDatabase } = await import('../src/server/db.ts');
const { Inbox } = await import('../src/server/inbox.ts');
const { World } = await import('../src/server/world.ts');
const { createInboxServer } = await import('../src/server/http.ts');
const cwd = join(home, 'checkout'); mkdirSync(cwd);
const db = openDatabase(join(home, 'inbox.sqlite'));
const inbox = new Inbox(db, join(home, 'files'), { available: () => false, forSession: () => null, resolvePane: () => null });
let title = null;
const source = { available: () => true, live: () => [{ harness: 'claude', sessionId: 'scratch', cwd, paneId: 'scratch', name: 'Mira', status: 'working', title }], prompt: async () => {}, notify: async () => {} };
const world = new World(db, source, () => inbox.state());
const team = await world.createTeam({ name: 'Review studio', standing: true });
const agentId = world.state().agents[0].id;
world.updateAgent(agentId, { teamId: team.id, role: 'lead', name: 'Mira' });
// A milestone for the inbox's answer box, submitted last so the office checks see nobody waiting.
const milestone = () => inbox.submit({ session: { harness: 'claude', sessionId: 'scratch', cwd }, item: { key: 'milestone', type: 'milestone', title: 'Lesson drafted', context: 'The first lesson is written.', fixed: 'Wrote the first lesson.' } }).itemId;
const probe = createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise((r) => probe.close(r)); assert.notEqual(port, 4870);
const server = createInboxServer(inbox, null, { port, staticDir: resolve('dist'), world });
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const origin = `http://localhost:${port}`;

// The office keeps changing while you speak: what she is on, activity and new questions.
let n = 0;
let inboxChurn = false;
const churn = setInterval(() => {
  n++;
  try {
  title = `Step ${n}`; // she stays at her desk, so the scene can click her
  world.onChange('world');
  // Questions send her to the clearing, out of the scene's click; so the inbox churns only for its own answer box.
  const session = { harness: 'claude', sessionId: 'scratch', cwd };
  if (inboxChurn && n % 3 === 0) inbox.activity({ session, title: `Step ${n}`, activity: `Working on step ${n}` });
  if (inboxChurn && n % 7 === 0) inbox.submit({ session, item: { key: `q${n}`, type: 'decide', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], title: `Question ${n}`, request: 'Which?' } });
  } catch (e) { console.error('churn', e.message); }
}, 250);

const results = [];
let browser;
try {
  mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ['--use-angle=metal'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  // Find the avatar in the mounted scene to click it, as a person would; no debug hooks in the app.
  await page.addInitScript(() => {
    window.__roots = new Set();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_, root) => window.__roots.add(root), onCommitFiberUnmount: () => {} };
    window.__scene = () => {
      let store, motion;
      const visit = (fiber) => {
        if (!fiber) return;
        const value = fiber.memoizedProps?.value;
        if (value?.getState && value.getState()?.scene) store = value.getState();
        const isAvatar = fiber.memoizedProps?.agent && fiber.memoizedProps?.spot;
        for (let h = fiber.memoizedState; h && typeof h === 'object'; h = h.next) { const v = h.memoizedState?.current; if (isAvatar && v?.path && v?.spot && v?.pos) motion = v; }
        visit(fiber.child); visit(fiber.sibling);
      };
      for (const root of window.__roots) visit(root.current);
      return { store, motion };
    };
  });
  await page.goto(`${origin}/#/world`);
  await page.waitForFunction(() => !!window.__scene().motion && !!window.__scene().store);

  // Each chat field: how to open it, then the box itself.
  const fields = [
    { name: 'Tell team', open: async () => { await page.locator('.team-list').getByText('Review studio').first().click(); }, box: () => page.locator('form.instruct textarea').first() },
    { name: 'Message agent', open: async () => { await page.locator('.member-list button.member').first().click(); }, box: () => page.getByLabel('Message Mira') },
    { name: 'Message agent (3D click)', noClick: true, open: async () => {
      await page.getByRole('button', { name: 'Close' }).first().click();
      await page.locator('.team-list').getByText('Review studio').first().click();
      await page.waitForTimeout(2500); // the flight to the bay
      await page.getByRole('button', { name: 'Close' }).first().click();
      await page.waitForTimeout(300);
      // Wherever she stands once she has stopped walking (a question can send her to the clearing).
      for (let tries = 0; tries < 5 && !(await page.getByLabel('Message Mira').count()); tries++) {
        await page.waitForFunction(() => window.__scene().motion.path.length === 0, null, { timeout: 70000 });
        const at = await page.evaluate(() => { const { store, motion } = window.__scene(); const [x, z] = motion.pos; const p = store.camera.position.clone().set(x, 1.1, z).project(store.camera); return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 }; });
        await page.mouse.click(at.x, at.y);
        await page.waitForTimeout(500);
      }
    }, box: () => page.getByLabel('Message Mira') },
    { name: 'Tell all leads', noClick: true, open: async () => { await page.getByRole('button', { name: 'Tell all leads' }).click(); }, box: () => page.getByLabel('Message to all leads') },
    { name: 'Answer note', open: async () => { const id = milestone(); inboxChurn = true; await page.goto(`${origin}/#/needs?item=${id}`); }, box: () => page.getByLabel('Optional note'), knows: () => page.getByText('Type a note, then click').isVisible() },
  ];
  const ways = {
    // Wispr Flow's usual way: text on the clipboard, then ⌘V.
    paste: async (text) => { await page.evaluate((t) => navigator.clipboard.writeText(t), text); await page.keyboard.press('ControlOrMeta+V'); },
    insertText: async (text) => { await cdp.send('Input.insertText', { text }); },
    // Simulated typing, one key at a time.
    typing: async (text) => { await page.keyboard.type(text, { delay: 5 }); },
    // An input method's marked text, held while the person speaks and the office updates, then committed.
    composition: async (text) => {
      for (let i = 1; i <= text.length; i += 4) { await cdp.send('Input.imeSetComposition', { text: text.slice(0, i), selectionStart: i, selectionEnd: i }); await page.waitForTimeout(150); }
      await cdp.send('Input.insertText', { text });
    },
    // Accessibility value set: the native setter, with and without the input event a browser would fire.
    setterWithInput: async (text) => page.evaluate((t) => { const el = document.activeElement; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, el.value + t); el.dispatchEvent(new Event('input', { bubbles: true })); }, text),
    setterNoInput: async (text) => page.evaluate((t) => { const el = document.activeElement; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, el.value + t); }, text),
  };

  for (const field of fields) {
    await field.open();
    const box = field.box();
    await box.waitFor();
    // Opened by clicking someone: the box is focused for you, and you start speaking without clicking it.
    if (field.noClick) results.push({ field: field.name, way: 'autofocus', ok: await box.evaluate((el) => el === document.activeElement), value: await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute('aria-label') ?? ''}`) });
    else await box.click();
    // Mark this node; a remount would replace it and lose the mark.
    await page.evaluate(() => { document.activeElement.dataset.dictationProbe = '1'; });
    // A dictation app finds the field through the accessibility tree: it must be a focused, editable textbox.
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map((x) => [x.nodeId, x]));
    const focused = nodes.find((x) => x.role?.value !== 'RootWebArea' && x.properties?.some((p) => p.name === 'focused' && p.value.value));
    if (process.env.DICTATION_AX) console.log('textboxes', JSON.stringify(nodes.filter((x) => x.role?.value === 'textbox').map((x) => ({ name: x.name?.value, ignored: x.ignored, props: x.properties?.map((p) => `${p.name}=${JSON.stringify(p.value.value)}`).join(' ') }))));
    const chain = [];
    for (let x = focused; x; x = byId.get(x.parentId)) chain.push({ role: x.role?.value, ignored: x.ignored, why: x.ignoredReasons?.map((r) => r.name).join(','), props: x.properties?.map((p) => `${p.name}=${JSON.stringify(p.value.value)}`).join(' ') });
    if (process.env.DICTATION_AX) console.log(field.name, JSON.stringify(chain, null, 1));
    const editable = focused?.properties?.find((p) => p.name === 'editable')?.value.value;
    results.push({ field: field.name, way: 'ax textbox', ok: focused?.role?.value === 'textbox' && !focused.ignored && editable === 'plaintext', value: `${focused?.role?.value} ${editable}` });
    // A dictation app holds the field's accessibility element from start to end: its AX id must not change.
    const { node } = await cdp.send('DOM.describeNode', { objectId: (await cdp.send('Runtime.evaluate', { expression: 'document.activeElement' })).result.objectId });
    const axId = async () => (await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false })).nodes[0]?.nodeId;
    const axIds = [await axId()];
    const sampling = (async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); axIds.push(await axId()); } })();
    // Speak for 10 s while the office updates, sampling focus.
    const lost = await page.evaluate(async () => {
      const out = [];
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        const a = document.activeElement;
        if (!a?.dataset?.dictationProbe) out.push({ at: Date.now(), tag: a?.tagName, cls: a?.className, mark: !!document.querySelector('[data-dictation-probe]') });
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    });
    await sampling;
    results.push({ field: field.name, way: 'focus 10s', ok: lost.length === 0, detail: lost.slice(0, 3) });
    results.push({ field: field.name, way: 'ax id 10s', ok: new Set(axIds).size === 1, value: [...new Set(axIds)].join(',') });
    for (const [way, insert] of Object.entries(ways)) {
      if (!field.noClick) await box.click();
      await box.fill('');
      const text = `dictated ${way} ${Date.now() % 1000}`;
      await insert(text);
      // Let a few updates land, as if the person waited before pressing send.
      await page.waitForTimeout(1500);
      const value = await box.inputValue();
      // The office knows the words too: its send button is on (the answer box's hint changes instead).
      const enabled = field.knows ? await field.knows() : await box.locator('xpath=ancestor::form//button[@type="submit"]').isEnabled();
      results.push({ field: field.name, way, ok: value.includes(text), sendEnabled: enabled, value });
    }
    await page.screenshot({ path: join(output, `${process.env.DICTATION_LABEL || 'check'}-${field.name.replace(/\s/g, '-').toLowerCase()}.png`) });
  }
  console.table(results.map((r) => ({ field: r.field, way: r.way, ok: r.ok, sendEnabled: r.sendEnabled ?? '', value: r.value ?? JSON.stringify(r.detail ?? '') })));
  assert.deepEqual(errors, []);
  if (!process.env.DICTATION_REPORT_ONLY) for (const r of results) assert.ok(r.ok && r.sendEnabled !== false, `${r.field}: ${r.way} failed`);
  console.log(`Checked dictation into chat fields; screenshots: ${output} (scratch port ${port})`);
} finally {
  clearInterval(churn);
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(home, { recursive: true, force: true });
}
