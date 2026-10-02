// Disposable office, real activity HTTP -> world -> scene; no herdr, account calls or live data.
// npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-meeting.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = chromium.executablePath();
const output = process.env.MEETING_SCREENSHOTS || join(homedir(), '.review-inbox/handoffs/agent-office/meeting');
const home = mkdtempSync(join(tmpdir(), 'office-meeting-'));
process.env.HOME = home; process.env.INBOX_DATA_DIR = join(home, 'data');
const { openDatabase } = await import('../src/server/db.ts');
const { Inbox } = await import('../src/server/inbox.ts');
const { World } = await import('../src/server/world.ts');
const { createInboxServer } = await import('../src/server/http.ts');
const cwd = join(home, 'checkout'); mkdirSync(cwd);
writeFileSync(join(cwd, 'lesson.ts'), [
  '// A small lesson under review',
  'export function chapterProgress(beats: boolean[]) {',
  '  const seen = beats.filter(Boolean).length;',
  '  return {',
  '    seen,',
  '    total: beats.length,',
  '    complete: seen === beats.length,',
  '  };',
  '}',
  '',
  '// Keep authored beats separate from playback.',
  'export const initialBeat = 0;',
].join('\n'));
const db = openDatabase(join(home, 'inbox.sqlite'));
const inbox = new Inbox(db, join(home, 'files'), { available: () => false, forSession: () => null, resolvePane: () => null });
const source = { available: () => true, live: () => [{ harness: 'claude', sessionId: 'scratch', cwd, paneId: 'scratch', name: 'Mira', status: 'working', title: null }], prompt: async () => {}, notify: async () => {} };
const world = new World(db, source, () => inbox.state());
const team = await world.createTeam({ name: 'Review studio', standing: true });
const id = world.state().agents[0].id;
world.updateAgent(id, { teamId: team.id, role: 'lead', name: 'Mira' });
const probe = createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise((r) => probe.close(r)); assert.notEqual(port, 4870);
const server = createInboxServer(inbox, null, { port, staticDir: resolve('dist'), world });
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const origin = `http://localhost:${port}`;
const hook = async (hook_event_name, extra = {}) => {
  const response = await fetch(`${origin}/api/hooks/claude`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ session_id: 'scratch', cwd, hook_event_name, ...extra }) });
  assert.equal(response.status, 200);
};
let browser;
try {
  mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // Inspect mounted scene for assertions/camera only. No shipped debug route or scene mock.
  await page.addInitScript(() => {
    localStorage.setItem('review-inbox.office-layout', 'building');
    window.__roots = new Set();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_, root) => window.__roots.add(root), onCommitFiberUnmount: () => {} };
    window.__scene = () => {
      let store, view, motion, avatar;
      const visit = (fiber) => {
        if (!fiber) return;
        const value = fiber.memoizedProps?.value;
        if (value?.getState && value.getState()?.scene) store = value.getState();
        const isAvatar = fiber.memoizedProps?.agent && fiber.memoizedProps?.spot;
        if (isAvatar) avatar = fiber.memoizedProps;
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
      return { store, view, motion, avatar };
    };
  });
  await page.goto(`${origin}/#/world`);
  await page.waitForFunction(() => !!window.__scene().motion);
  assert.equal(await page.evaluate(() => window.__scene().avatar.spot.zone), 'team');
  await hook('SubagentStart', { agent_id: 'reviewer', agent_type: '.claude/agents/code-reviewer.md' });
  await hook('PreToolUse', { agent_id: 'reviewer', tool_name: 'Read', tool_input: { file_path: join(cwd, 'lesson.ts') } });
  const state = await (await fetch(`${origin}/api/world`)).json();
  assert.equal(state.agents[0].helpers[0].excerpt.lines.length, 12);
  await page.waitForFunction(() => window.__scene().motion.spot.zone === 'meeting');
  assert.ok(await page.evaluate(() => window.__scene().motion.path.length > 0), 'walks rather than teleporting');
  await page.waitForFunction(() => window.__scene().motion.path.length === 0, null, { timeout: 70000 });
  assert.equal(await page.evaluate(() => window.__scene().avatar.spot.sit), true);
  const setView = async (v) => { await page.evaluate((v) => { const { store, view } = window.__scene(); Object.assign(view, v); store.invalidate(); }, v); await page.waitForTimeout(1000); };
  // First room: centre [5.1,13.14], back at z=17.64; local -x is world east.
  await setView({ x: 3.9, z: 9.5, yaw: Math.PI - 0.12, pitch: -0.16, lift: 0.065, fov: 66 });
  await page.screenshot({ path: join(output, 'review-room.png') });
  await setView({ x: 5.1, z: 13.9, yaw: Math.PI, pitch: 0.20, lift: 0, fov: 66 });
  await page.screenshot({ path: join(output, 'projector-code.png') });
  await setView({ x: 4.4, z: 13.4, yaw: Math.PI / 2, pitch: 0.17, lift: 0, fov: 67 });
  await page.screenshot({ path: join(output, 'architecture-whiteboard.png') });
  await setView({ x: 3.7, z: 10.7, yaw: Math.PI - 0.3, pitch: -0.50, lift: 0.005, fov: 58 });
  await page.screenshot({ path: join(output, 'table-projector.png') });
  await setView({ x: 10.6, z: 13.4, yaw: Math.PI / 2, pitch: 0.17, lift: 0, fov: 67 });
  await page.screenshot({ path: join(output, 'tooling-whiteboard.png') });
  await hook('SubagentStop', { agent_id: 'reviewer' });
  await page.waitForFunction(() => window.__scene().motion.spot.zone === 'team');
  assert.ok(await page.evaluate(() => window.__scene().motion.path.length > 0), 'walks back on review end');
  await page.waitForFunction(() => window.__scene().motion.path.length === 0, null, { timeout: 70000 });
  await setView({ x: 5.1, z: 13.9, yaw: Math.PI, pitch: 0.20, lift: 0, fov: 66 });
  await page.screenshot({ path: join(output, 'projector-idle.png') });
  assert.deepEqual(errors, []);
  console.log(`Checked review start/read/stop, walking both ways, seated pose and idle slide; port ${port}; screenshots ${output}`);
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); db.close(); rmSync(home, { recursive: true, force: true });
}
