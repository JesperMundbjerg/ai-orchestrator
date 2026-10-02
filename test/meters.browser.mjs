// Synthetic feeders in an isolated office; run against the built UI, not a live service.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs FEEDERS_SCREENSHOTS=/output node test/meters.browser.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = chromium.executablePath();
const output = resolve(process.env.FEEDERS_SCREENSHOTS || 'feeders-screenshots');
const home = mkdtempSync(join(tmpdir(), 'office-feeders-'));
Object.assign(process.env, {
  HOME: home, INBOX_DATA_DIR: join(home, 'data'),
  HERDR_SOCKET_PATH: '/nonexistent', HERDR_BIN_PATH: '/usr/bin/false',
  INBOX_PRESENCE_DISCOVERY: '0', INBOX_CODEX_ACCOUNT_POLLING: '0', INBOX_BROWSER_CLEANUP: '0',
});
const { openDatabase } = await import('../src/server/db.ts');
const { Inbox } = await import('../src/server/inbox.ts');
const { createInboxServer } = await import('../src/server/http.ts');
const db = openDatabase(join(home, 'inbox.sqlite'));
const inbox = new Inbox(db, join(home, 'files'), { available: () => false, forSession: () => null, resolvePane: () => null });
const meter = (id, label, window) => ({ id, label, window, usedPercent: 20, resetsAt: new Date(Date.now() + 10 * 3600_000).toISOString(), asOf: new Date().toISOString(), stale: false });
const state = { teams: [], agents: [], messages: [], withFounder: [], work: [], repositories: [], herdr: 'unavailable', usage: {
  meters: [meter('week', 'Claude week', 'week'), meter('five', 'Claude 5-hour', 'five_hour')], agents: {}, teams: {},
} };
const world = { state: () => state, react: async () => {}, onChange: () => {} };
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Inspect the mounted production scene, with no shipped camera or debug API changes.
  await page.addInitScript(() => {
    window.__roots = new Set();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_, root) => window.__roots.add(root), onCommitFiberUnmount: () => {} };
    window.__scene = () => {
      let store, view;
      const feeders = new Map();
      const visit = (fiber) => {
        if (!fiber) return;
        const props = fiber.memoizedProps;
        if (props?.value?.getState && props.value.getState()?.scene) store = props.value.getState();
        if (props?.spot && props?.look) feeders.set(props.spot.id, { spot: props.spot, look: props.look });
        let hook = fiber.memoizedState;
        while (hook && typeof hook === 'object') {
          const value = hook.memoizedState?.current;
          if (value && typeof value.eye === 'number' && typeof value.yaw === 'number' && typeof value.fov === 'number') view = value;
          hook = hook.next;
        }
        visit(fiber.child); visit(fiber.sibling);
      };
      for (const root of window.__roots) visit(root.current);
      return { store, view, feeders };
    };
    window.__feeders = () => {
      const { store, feeders } = window.__scene();
      const result = [];
      store.scene.traverse((ring) => {
        if (ring.geometry?.type !== 'RingGeometry' || ring.position.y !== 0.014) return;
        const feeder = [...feeders.values()].find(({ spot }) => Math.abs(spot.pos[0] - ring.parent.position.x) < 1e-6 && Math.abs(spot.pos[1] - ring.parent.position.z) < 1e-6);
        if (!feeder) return;
        const { spot, look } = feeder;
        const positions = ring.geometry.getAttribute('position');
        let angle = 0;
        for (let i = 1; i <= 40; i++) {
          const a = Math.atan2(positions.getY(i - 1), positions.getX(i - 1));
          const b = Math.atan2(positions.getY(i), positions.getX(i));
          angle += Math.atan2(Math.sin(b - a), Math.cos(b - a));
        }
        const seed = ring.parent.children[0].children.find((o) => o.geometry?.type === 'CylinderGeometry' && Math.abs(o.scale.x - spot.glass * 0.94) < 1e-6);
        result.push({ id: spot.id, spot, label: look.label, target: look.left, fraction: angle / (Math.PI * 2), visible: ring.visible, color: ring.material.color.getHexString(), geometry: ring.geometry.uuid, seed: seed.scale.y / spot.height, pinned: ring.parent.children.some((o) => o.isSprite) });
      });
      return result.sort((a, b) => a.id.localeCompare(b.id));
    };
  });
  await page.goto(`http://localhost:${port}/#/world`);
  await page.waitForFunction(() => window.__scene().view && window.__scene().feeders.size === 2);
  await page.waitForTimeout(500);
  const readings = () => page.evaluate(() => window.__feeders());
  const initial = await readings();
  assert.equal(initial.length, 2);
  const weekly = initial.find((f) => f.id === 'week');
  await page.evaluate(({ spot }) => {
    const { store, view } = window.__scene();
    Object.assign(view, { x: spot.pos[0] + 2, z: spot.pos[1] + 3.5, yaw: -0.52, pitch: -0.22, lift: 0, fov: 50 });
    store.invalidate();
  }, weekly);
  await page.waitForTimeout(800);
  const point = await page.evaluate(({ spot }) => {
    const { store } = window.__scene();
    const p = store.camera.position.clone().set(spot.pos[0], spot.post + spot.height / 2, spot.pos[1]).project(store.camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  }, weekly);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(200);
  assert.ok((await readings()).find((f) => f.id === 'week').pinned, 'hover reveals reset label');
  await page.mouse.click(point.x, point.y);
  await page.mouse.move(1350, 900);
  await page.waitForTimeout(200);
  assert.ok((await readings()).find((f) => f.id === 'week').pinned, 'click pins label after pointer leaves');

  const evidence = [];
  for (const [used, color] of [[20, '4fae5c'], [76, 'e9a23b'], [100, 'd9493f'], [0, '4fae5c']]) {
    if (used !== 20) {
      const before = await readings();
      for (const m of state.usage.meters) m.usedPercent = used;
      world.onChange('usage');
      await page.waitForFunction((target) => window.__feeders().every((f) => f.target === target), (100 - used) / 100);
      await page.waitForTimeout(100);
      const during = await readings();
      for (const [i, f] of during.entries()) {
        assert.ok(f.fraction > Math.min(before[i].fraction, f.target) && f.fraction < Math.max(before[i].fraction, f.target), 'ring eases rather than jumping, including refills');
        assert.ok(Math.abs(f.fraction - f.seed) < 1e-6, 'ring and seed animate together');
        assert.equal(f.geometry, initial[i].geometry, 'animation reuses its geometry');
      }
      await page.waitForTimeout(2800);
    }
    const settled = await readings();
    for (const f of settled) {
      assert.ok(Math.abs(f.fraction - (100 - used) / 100) < 1e-6, 'arc shows usage remaining');
      assert.equal(f.visible, used !== 100);
      assert.equal(f.color, color);
      assert.match(f.label, new RegExp(` · ${used}% used · resets in 10 h$`));
    }
    evidence.push({ used, readings: settled });
    await page.screenshot({ path: join(output, `feeders-${used}-used.png`) });
  }
  await page.mouse.click(point.x, point.y);
  await page.mouse.move(1350, 900);
  await page.waitForTimeout(200);
  assert.equal((await readings()).find((f) => f.id === 'week').pinned, false, 'second click unpins');
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'checks.json'), JSON.stringify({ browser: await browser.version(), port, evidence, errors }, null, 2));
  writeFileSync(join(output, 'README.md'), '# Feeder usage rings\n\nSynthetic Claude weekly and 5-hour readings in an otherwise empty scratch office; no real sessions or account data. Headless Chromium, 1440×1000, built production UI. Temporary HOME/data, free port, herdr disabled, all three integration opt-ins off. Camera positioned by inspecting the mounted scene; real pointer hover/pin/unpin. Checks assert 20%/76%/100%/0% usage, green/amber/red tones, empty/full endpoints, smooth SSE-driven drain/refill in lockstep with seed, stable geometry, and reset text in the pinned label.\n');
  console.log(`PASS: feeder tones, remaining arcs, smooth drain/refill, hover/pin/reset labels. Scratch port ${port}; screenshots ${output}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(home, { recursive: true, force: true });
}
