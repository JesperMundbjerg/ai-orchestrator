// Run against a built, archived tree. A disposable office only; no live herdr or account reads.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/review-fallback.browser.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = chromium.executablePath();
const output = process.env.PROJECTOR_SCREENSHOTS || join(homedir(), '.review-inbox/handoffs/agent-office/projector');
const home = mkdtempSync(join(tmpdir(), 'office-projector-'));
process.env.HOME = home; process.env.INBOX_DATA_DIR = join(home, 'data');
process.env.HERDR_SOCKET_PATH = '/nonexistent'; process.env.HERDR_BIN_PATH = '/usr/bin/false';
const { openDatabase } = await import('../src/server/db.ts');
const { Inbox } = await import('../src/server/inbox.ts');
const { World } = await import('../src/server/world.ts');
const { createInboxServer } = await import('../src/server/http.ts');
const cwd = join(home, 'checkout'); mkdirSync(cwd);
const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
git('init', '-b', 'main'); git('config', 'user.name', 'Projector'); git('config', 'user.email', 'projector@example.test');
writeFileSync(join(cwd, 'base.ts'), 'export const base = true;');
git('add', '.'); git('commit', '-m', 'base'); git('switch', '-c', 'review');
writeFileSync(join(cwd, 'lesson.ts'), [
  '// A small lesson under review',
  'export function chapterProgress(beats: boolean[]) {',
  '  const seen = beats.filter(Boolean).length;',
  '  return {', '    seen,', '    total: beats.length,',
  '    complete: seen === beats.length,', '  };', '}', '',
  '// Keep authored beats separate from playback.', 'export const initialBeat = 0;',
].join('\n'));
git('add', '.'); git('commit', '-m', 'lesson');
const db = openDatabase(join(home, 'inbox.sqlite'));
const inbox = new Inbox(db, join(home, 'files'), { available: () => false, forSession: () => null, resolvePane: () => null });
const live = [{ harness: 'claude', sessionId: 'scratch', cwd, paneId: 'scratch', name: 'Mira', status: 'working', title: null }];
const source = { available: () => true, live: () => live, prompt: async () => {}, notify: async () => {} };
const world = new World(db, source, () => inbox.state());
const team = await world.createTeam({ name: 'Review studio', standing: true });
const id = world.state().agents[0].id;
world.updateAgent(id, { teamId: team.id, role: 'lead', name: 'Mira' });
// Listen on a kernel-selected port, then create the guarded HTTP server at that port.
const { createServer } = await import('node:net');
const probe = createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise((r) => probe.close(r)); assert.notEqual(port, 4870);
const server = createInboxServer(inbox, null, { port, staticDir: resolve('dist'), world });
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const origin = `http://localhost:${port}`;
const hook = async (hook_event_name, extra = {}) => {
  const response = await fetch(`${origin}/api/hooks/claude`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ session_id: 'scratch', cwd, hook_event_name, ...extra }) });
  assert.equal(response.status, 200);
};
const state = async () => (await (await fetch(`${origin}/api/world`)).json());
let browser;
try {
  mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__roots = new Set();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_, root) => window.__roots.add(root), onCommitFiberUnmount: () => {} };
    window.__scene = () => {
      let store, view, motion, avatar, reviewer;
      const visit = (fiber) => {
        if (!fiber) return;
        const value = fiber.memoizedProps?.value;
        if (value?.getState && value.getState()?.scene) store = value.getState();
        const isAvatar = fiber.memoizedProps?.agent && fiber.memoizedProps?.spot;
        if (isAvatar) avatar = fiber.memoizedProps;
        if (fiber.memoizedProps?.reviewer) reviewer = fiber.memoizedProps.reviewer;
        let h = fiber.memoizedState;
        while (h && typeof h === 'object') {
          const v = h.memoizedState?.current;
          if (v && typeof v.eye === 'number' && typeof v.yaw === 'number') view = v;
          if (isAvatar && v?.path && v?.spot && v?.pos) motion = v;
          h = h.next;
        }
        visit(fiber.child); visit(fiber.sibling);
      };
      for (const root of window.__roots) visit(root.current);
      return { store, view, motion, avatar, reviewer };
    };
  });
  await page.goto(`${origin}/#/world`);
  await page.waitForFunction(() => !!window.__scene().motion);
  await hook('SubagentStart', { agent_id: 'reviewer', agent_type: 'code-reviewer' });
  await state(); // Cold snapshots schedule background git and return without waiting.
  await page.waitForFunction(() => window.__scene().reviewer?.reviewExcerpt?.path === 'lesson.ts');
  const fallback = (await state()).agents[0];
  assert.equal(fallback.helpers[0].excerpt, undefined, 'no helper read was reported');
  assert.equal(fallback.reviewExcerpt.path, 'lesson.ts', 'branch code without agent work');
  assert.deepEqual((await state()).agents[0].reviewExcerpt, fallback.reviewExcerpt);
  // The real HTTP server broadcasts activity changes, including slot refreshes.
  await page.waitForFunction(() => window.__scene().reviewer?.reviewExcerpt?.path === 'lesson.ts');
  await page.waitForFunction(() => window.__scene().motion?.path.length === 0, null, { timeout: 70000 });
  const setView = async (v) => { await page.evaluate((v) => { const { store, view } = window.__scene(); Object.assign(view, v); store.invalidate(); }, v); await page.waitForTimeout(1500); };
  await setView({ x: 3.9, z: 9.5, yaw: Math.PI - 0.12, pitch: -0.16, lift: 0.065, fov: 66 });
  await page.screenshot({ path: join(output, 'review-fallback-room.png') });
  await setView({ x: 5.1, z: 13.9, yaw: Math.PI, pitch: 0.20, lift: 0, fov: 66 });
  await page.screenshot({ path: join(output, 'projector-fallback.png') });
  // Save the actual mounted projector canvas, not a separately mocked slide.
  const slide = await page.evaluate(() => {
    const slides = [];
    window.__scene().store.scene.traverse((o) => { const image = o.material?.map?.image; if (image?.width === 1440 && image?.height === 820) slides.push(image.toDataURL()); });
    return slides[0];
  });
  assert.ok(slide); writeFileSync(join(output, 'projector-fallback-texture.png'), Buffer.from(slide.split(',')[1], 'base64'));
  await hook('PreToolUse', { agent_id: 'reviewer', tool_name: 'Read', tool_input: { file_path: join(cwd, 'base.ts') } });
  assert.equal((await state()).agents[0].reviewExcerpt.path, 'base.ts', 'real read wins');
  await page.reload();
  await page.waitForFunction(() => window.__scene().reviewer?.reviewExcerpt?.path === 'base.ts');
  await setView({ x: 5.1, z: 13.9, yaw: Math.PI, pitch: 0.20, lift: 0, fov: 66 });
  await page.screenshot({ path: join(output, 'projector-helper-read.png') });
  await hook('SubagentStop', { agent_id: 'reviewer' });
  assert.equal((await state()).agents[0].reviewExcerpt, null);
  const authorCwd = join(home, 'author');
  execFileSync('git', ['clone', cwd, authorCwd], { stdio: 'ignore' });
  writeFileSync(join(authorCwd, 'authored.ts'), 'export const submittedForReview = true;');
  live.push({ harness: 'claude', sessionId: 'author', cwd: authorCwd, paneId: 'author', name: 'Author', status: 'working', title: null });
  const authors = await world.createTeam({ name: 'Authors', standing: true });
  const author = world.state().agents.find((a) => a.cwd === authorCwd);
  world.updateAgent(author.id, { teamId: authors.id, role: 'lead' });
  const handed = world.messages.handoff(world.agent(author.id), { title: 'Authored change', summary: 'Check authored.ts', to: team.name });
  await state();
  await page.waitForFunction(() => window.__scene().reviewer?.reviewExcerpt?.path === 'authored.ts');
  const pending = (await state()).agents.find((a) => a.id === id);
  assert.deepEqual(pending.helpers, []);
  assert.equal(pending.reviewExcerpt.path, 'authored.ts', 'helperless review uses author checkout, not reviewer checkout');
  await page.reload();
  await page.waitForFunction(() => window.__scene().reviewer?.reviewExcerpt?.path === 'authored.ts');
  await setView({ x: 5.1, z: 13.9, yaw: Math.PI, pitch: 0.20, lift: 0, fov: 66 });
  await page.screenshot({ path: join(output, 'projector-helperless-handoff.png') });
  world.messages.review(world.agent(id), { work: handed.work.id, verdict: 'accept' });
  assert.equal((await state()).agents.find((a) => a.id === id).reviewExcerpt, null);
  assert.deepEqual(errors, []);
  console.log(`Verified fallback without helper reads, real-read precedence, helperless handoff, review stop and rendered projector; scratch port ${port}; ${output}`);
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); db.close(); rmSync(home, { recursive: true, force: true });
}
