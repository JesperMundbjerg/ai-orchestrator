// Headless visual check against a disposable office. No herdr, account reads or live data.
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/check-jars.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = chromium.executablePath();
const output = process.env.JARS_SCREENSHOTS || join(homedir(), '.review-inbox/handoffs/agent-office/usage');
const home = mkdtempSync(join(tmpdir(), 'office-jars-'));
process.env.HOME = home;
process.env.INBOX_DATA_DIR = join(home, 'data');
const { openDatabase } = await import('../src/server/db.ts');
const { Inbox } = await import('../src/server/inbox.ts');
const { createInboxServer } = await import('../src/server/http.ts');
const db = openDatabase(join(home, 'inbox.sqlite'));
const inbox = new Inbox(db, join(home, 'files'), { available: () => false, forSession: () => null, resolvePane: () => null });
const teams = ['busy', 'small', 'empty'].map((id, i) => ({ id, name: ['Busy studio', 'Small studio', 'Empty week'][i], purpose: '', standing: false, path: join(home, id), worktrees: [], branch: `project-${id}`, handsTo: null, createdAt: '', status: 'idle', blockedBy: [] }));
const agents = teams.flatMap((t) => [0, 1, 2].map((i) => ({ id: `${t.id}-${i}`, identity: `${t.id}-${i}`, name: ['Lead', 'Maker', 'Painter'][i], harness: 'manual', cwd: t.path, project: null, branch: t.branch, status: 'done', title: null, paneId: null, taskIds: [], teamId: t.id, role: i ? 'member' : 'lead', waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true })));
const meter = (id, label, percent) => ({ id, label, window: 'week', usedPercent: percent, resetsAt: new Date(Date.now() + 4 * 864e5).toISOString(), asOf: new Date().toISOString(), stale: false });
const use = (a, b, x, y) => ({ tokens: a + b, share: x + y, parts: [{ meter: 'one.week', tokens: a, share: x }, { meter: 'two.week', tokens: b, share: y }] });
const worldState = { teams, agents, messages: [], withFounder: [], work: [], repositories: [], herdr: 'unavailable', usage: { meters: [meter('one.week', 'Claude week', 40), meter('two.week', 'Codex week', 30)], agents: {}, teams: { busy: use(1_200_000, 800_000, 4, 7), small: use(120_000, 40_000, 0.4, 0.3), empty: use(0, 0, 0, 0) } } };
const world = { state: () => worldState, react: async () => {}, onChange: () => {} };
const probe = createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
assert.notEqual(port, 4870);
const server = createInboxServer(inbox, null, { port, staticDir: resolve('dist'), world });
await new Promise((r) => server.listen(port, '127.0.0.1', r));
let browser;
try {
  mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Inspect React's mounted scene without adding a test/debug camera to the shipped app.
  await page.addInitScript(() => {
    window.__roots = new Set();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_, root) => window.__roots.add(root), onCommitFiberUnmount: () => {} };
    window.__scene = () => {
      let store, view;
      const visit = (fiber) => {
        if (!fiber) return;
        const value = fiber.memoizedProps?.value;
        if (value?.getState && value.getState()?.scene) store = value.getState();
        let hook = fiber.memoizedState;
        while (hook && typeof hook === 'object') {
          const v = hook.memoizedState?.current;
          if (v && typeof v.eye === 'number' && typeof v.yaw === 'number' && typeof v.fov === 'number') view = v;
          hook = hook.next;
        }
        visit(fiber.child); visit(fiber.sibling);
      };
      for (const root of window.__roots) visit(root.current);
      return { store, view };
    };
  });
  await page.goto(`http://localhost:${port}/#/world`);
  await page.waitForFunction(() => !!window.__scene().store && !!window.__scene().view);
  const setView = async (v) => {
    await page.evaluate((v) => { const { view, store } = window.__scene(); Object.assign(view, v); store.invalidate(); }, v);
    await page.waitForTimeout(700);
  };
  const jars = () => page.evaluate(() => {
    const { store } = window.__scene(); const found = [];
    store.scene.updateMatrixWorld(true);
    store.scene.traverse((o) => { if (o.name.startsWith('usage-jar:')) { const p = o.position.clone(); o.getWorldPosition(p); found.push({ name: o.name, facing: o.parent.rotation.y, pos: p.toArray(), visible: o.children[0].children[0].visible, shown: o.children[0].children[0].scale.y / 0.38, detail: !!o.getObjectByName('jar-detail'), ...o.userData }); } });
    return found;
  });
  for (const layout of ['ring', 'building']) {
    await page.getByRole('button', { name: layout === 'ring' ? 'Ring' : 'Building', exact: true }).click();
    await page.waitForTimeout(800);
    const list = await jars();
    assert.equal(list.length, 6);
    assert.deepEqual(list.map((j) => j.targetFill), [0.6, 0.4, 0.06, 0.02, 0, 0]);
    assert.deepEqual(list.map((j) => j.visible), [true, true, true, true, false, false]);
    await setView({ x: 0, z: 2, yaw: 0, pitch: -1.45, lift: 1, fov: 80 });
    await page.screenshot({ path: join(output, `jars-${layout}-overview.png`) });
    for (const [i, name] of ['busy', 'small', 'empty'].entries()) {
      const pair = list.slice(i * 2, i * 2 + 2);
      const x = (pair[0].pos[0] + pair[1].pos[0]) / 2;
      const z = (pair[0].pos[2] + pair[1].pos[2]) / 2;
      const facing = pair[0].facing;
      await setView({ x: x - Math.sin(facing) * 2.5, z: z - Math.cos(facing) * 2.5, yaw: Math.PI - facing, pitch: -0.19, lift: 0, fov: 35 });
      // Hover the first jar's glass via its projected centre, asserting real pointer handling.
      const point = await page.evaluate(({ name, x, z }) => {
        const { store } = window.__scene();
        const p = store.camera.position.clone().set(x, 1.08, z).project(store.camera);
        return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
      }, { name, x: pair[0].pos[0], z: pair[0].pos[2] });
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(300);
      assert.equal((await jars())[i * 2].detail, true, 'hover reveals the exact text');
      await page.screenshot({ path: join(output, `jars-${layout}-${name}.png`) });
      await page.mouse.click(point.x, point.y);
      await page.mouse.move(1450, 850);
      await page.waitForTimeout(200);
      assert.equal((await jars())[i * 2].detail, true, 'click pins the text after the pointer leaves');
      await page.mouse.click(point.x, point.y);
      await page.mouse.move(1450, 850);
      await page.waitForTimeout(200);
      assert.equal((await jars())[i * 2].detail, false, 'second click unpins');
    }
  }
  // SSE refresh changes a level without replacing the scene; resetting the week removes every seed.
  worldState.usage.teams.small = use(600_000, 200_000, 2, 1);
  world.onChange('usage');
  await page.waitForTimeout(2400);
  assert.equal((await jars())[2].targetFill, 0.3);
  assert.ok(Math.abs((await jars())[2].shown - 0.3) < 0.001);
  worldState.usage.teams = {};
  world.onChange('usage');
  await page.waitForTimeout(2600);
  assert.ok((await jars()).every((j) => j.targetFill === 0 && j.shown === 0 && !j.visible));
  assert.deepEqual(errors, []);
  console.log(`Checked both layouts, six jars each; screenshots: ${output}/jars-*.png (scratch port ${port})`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(home, { recursive: true, force: true });
}
