// Headless, disposable office: no real herdr, account reads, or live inbox data.
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/check-garden-ui.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = chromium.executablePath();
const output = process.env.GARDEN_SCREENSHOTS || join(homedir(), '.review-inbox/handoffs/agent-office/garden-ui');
const phase = process.env.GARDEN_PHASE || 'after';
const home = mkdtempSync(join(tmpdir(), 'office-garden-'));
process.env.HOME = home;
process.env.INBOX_DATA_DIR = join(home, 'data');
process.env.HERDR_SOCKET_PATH = '/nonexistent';
process.env.HERDR_BIN_PATH = '/usr/bin/false';
const { openDatabase } = await import('../src/server/db.ts');
const { Inbox } = await import('../src/server/inbox.ts');
const { World } = await import('../src/server/world.ts');
const { createInboxServer } = await import('../src/server/http.ts');
const db = openDatabase(join(home, 'inbox.sqlite'));
const names = ['Clara', 'Mira', 'Rowan', 'Alma', 'Noor', 'Emil'];
const live = names.map((name, i) => {
  const cwd = join(home, name); mkdirSync(cwd);
  return { harness: 'manual', sessionId: name, cwd, paneId: `scratch-${i}`, name, status: 'working', title: 'Checking the next increment' };
});
const source = { available: () => true, live: () => live, forSession: () => null, resolvePane: () => null, prompt: async () => {}, notify: async () => {} };
const inbox = new Inbox(db, join(home, 'files'), source);
const world = new World(db, source, () => inbox.state());
let server, browser;
try {
  const teams = [];
  for (const name of ['Garden studio', 'Field notes', 'Mission Control']) teams.push(await world.createTeam({ name, standing: true, purpose: 'Small, readable increments; keep the next step clear.' }));
  for (const [i, person] of live.entries()) {
    const a = world.state().agents.find((a) => a.paneId === person.paneId);
    assert.ok(a);
    world.updateAgent(a.id, { name: person.name, teamId: teams[Math.floor(i / 2)].id, role: i % 2 ? 'member' : 'lead' });
  }
  const clara = world.state().agents.find((a) => a.name === 'Clara');
  const mira = world.state().agents.find((a) => a.name === 'Mira');
  world.messages.tell(clara.id, { text: 'Keep the garden quiet and the project list easy to scan.' });
  world.messages.say(clara, { to: 'founder', text: 'The first pass is ready. Paper notes keep the conversation readable; the crew stays grouped by project.' });
  world.messages.say(mira, { to: 'Clara', text: 'I checked the dense member list and the narrow layout. The names and status labels still line up.' });
  world.messages.handoff(clara, { to: 'Field notes', title: 'Garden notes', summary: 'The project summary is ready for review. Check the names, message history and next step.' });
  const session = { harness: 'manual', sessionId: 'review', cwd: home };
  inbox.submit({ session, project: { name: 'Garden studio' }, task: { title: 'Readable project notes' }, item: { type: 'decide', title: 'Keep the project summary above the conversation?', request: 'The summary keeps the next step in view. Until you answer, it stays above the notes.', options: ['Above: keep the next step visible', 'Below: start with the conversation'], recommendation: 'Above, so the next step is easy to find.', context: 'Both arrangements keep the complete conversation available.' } });
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  assert.notEqual(port, 4870);
  const origin = `http://localhost:${port}`;
  const trial = inbox.submit({ session, item: { type: 'try', title: 'Read through the project notes', request: 'Check that the summary and notes are easy to read.', check: 'Read the names and messages, then approve or leave a change request.', preview: `${origin}/sample` } });
  server = createInboxServer(inbox, null, { port, staticDir: resolve('dist'), world });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('review-inbox.office-layout', 'building'));
  const shot = (name) => page.screenshot({ path: join(output, `${phase}-${name}.png`), fullPage: true });
  const contrasts = {};
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${origin}/#/world`);
    await page.locator('.team-go').filter({ hasText: 'Garden studio' }).click();
    await shot(`team-panel-${scheme}`);
    await page.locator('.world-panel.agent .member').filter({ hasText: 'Clara' }).click();
    await page.locator('.chat .say').last().waitFor();
    await page.locator('.world-panel.agent').evaluate((el) => el.scrollTop = 0);
    await page.waitForTimeout(1200);
    await shot(`office-${scheme}`);
    await page.getByRole('textbox', { name: 'Message Clara', exact: true }).fill('A draft stays readable.');
    assert.ok(await page.locator('.world-panel.agent').getByRole('button', { name: 'Send', exact: true }).isEnabled());
    await page.getByRole('textbox', { name: 'Message Clara', exact: true }).fill('');
    assert.ok(await page.locator('.world-panel.teams').isVisible());
    if (await page.getByRole('button', { name: 'Hide Projects panel' }).count()) {
      await page.getByRole('button', { name: 'Hide Projects panel' }).click();
      await page.getByRole('button', { name: 'Show Projects panel' }).click();
      assert.ok(await page.locator('.world-panel.teams').isVisible());
    }
    await page.goto(`${origin}/#/teams`);
    await page.locator('.card-member').first().waitFor();
    await shot(`board-${scheme}`);
    await page.getByRole('button', { name: 'Tell all leads', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await shot(`broadcast-${scheme}`);
    await page.getByRole('dialog').getByRole('checkbox').first().uncheck();
    assert.equal(await page.getByRole('dialog').getByRole('checkbox', { checked: true }).count(), 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('button', { name: 'Everything', exact: true }).click();
    assert.ok(await page.locator('.order').filter({ hasText: 'I checked the dense member list' }).isVisible());
    await page.getByRole('button', { name: 'With me', exact: true }).click();
    await page.goto(`${origin}/#/needs`);
    await page.locator('.decision-card').first().waitFor();
    await shot(`inbox-${scheme}`);
    await page.goto(`${origin}/#/needs?item=${trial.itemId}`);
    await page.locator('.item-head').waitFor();
    await shot(`try-${scheme}`);
    if (phase !== 'before') {
      const plain = await page.locator('.item').evaluate((el) => getComputedStyle(el).backgroundImage);
      assert.equal(plain, 'none', 'review item stays undecorated');
    }
    // Token contrasts are measured in the browser's active colour scheme, not a second palette.
    if (phase !== 'before') contrasts[scheme] = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const value = (name) => style.getPropertyValue(`--${name}`).trim();
      const luminance = (hex) => {
        const c = hex.replace('#', '').match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
      };
      const pairs = ['text/panel', 'muted/panel', 'muted/panel-2', 'muted/bg', 'text/paper', 'muted/paper', 'muted/paper-you', 'accent/accent-soft', 'on-accent/accent', 'decide/decide-soft', 'try/try-soft', 'milestone/milestone-soft', 'warn/panel', 'ok/panel', 'muted/line'];
      return Object.fromEntries(pairs.map((p) => { const [a, b] = p.split('/').map((n) => luminance(value(n))); return [p, (Math.max(a, b) + .05) / (Math.min(a, b) + .05)]; }));
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/#/teams`);
  await page.locator('.card-member').first().waitFor();
  await shot('board-phone');
  if (phase !== 'before') {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'phone board does not overflow');
    for (const [scheme, pairs] of Object.entries(contrasts)) for (const [pair, ratio] of Object.entries(pairs)) assert.ok(ratio >= 4.5, `${scheme} ${pair}: ${ratio.toFixed(2)} < AA`);
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(output, `${phase}-checks.json`), JSON.stringify({ port, headless: true, contrasts, errors }, null, 2));
  console.log(`Garden UI checked on scratch port ${port}; screenshots: ${output}`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  db.close(); rmSync(home, { recursive: true, force: true });
}
