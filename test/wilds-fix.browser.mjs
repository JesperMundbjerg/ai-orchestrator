// Production-only real kilometre walk, isolated scratch office. No live data or founder prompts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { populate } from '../src/ui/world/wilds/animals.ts';
import { planBuilding } from '../src/ui/world/building.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const out = join(homedir(), '.review-inbox/handoffs/agent-office/wilds-fix', process.env.WILDS_RUN ?? 'after');
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), 'wilds-fix-'));
const socket = createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const office = spawn(process.execPath, ['src/server/main.ts'], { env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, 'data'), INBOX_PORT: String(port), HERDR_SOCKET_PATH: '/nonexistent', HERDR_BIN_PATH: '/usr/bin/false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
office.stdout.on('data', d => logs += d);
office.stderr.on('data', d => logs += d);
const summary = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1) };
};
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i > 100) throw Error(logs);
    await delay(100);
  }
  assert.equal((await (await fetch(`${url}/api/world`)).json()).agents.length, 0);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem('review-inbox.office-layout', 'building'));
  await page.goto(`${url}/?wildsMeasure=1#/world`);
  await page.waitForFunction(() => window.__wilds?.read().chunks === 81, null, { timeout: 30000 });
  const read = () => page.evaluate(() => window.__wilds.read());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapBefore = await cdp.send('Runtime.getHeapUsage');
  await page.getByRole('button', { name: 'Front door ↗' }).click();
  await delay(2200);
  await page.screenshot({ path: join(out, 'front-door.png') });
  await page.keyboard.down('Shift'); await page.keyboard.down('w');
  await page.waitForFunction(() => window.__wilds.read().position[2] >= 60, null, { timeout: 30000 });
  const start = await read(), z0 = start.position[2], firstSeq = start.samples.at(-1).seq;
  const frames = new Map();
  let end;
  for (let i = 0; ; i++) {
    end = await read();
    for (const f of end.samples) if (f.seq > firstSeq) frames.set(f.seq, f);
    if (end.position[2] >= z0 + 1000) break;
    if (i > 600) throw Error('walk timed out');
    await delay(250);
  }
  await page.keyboard.up('w'); await page.keyboard.up('Shift');
  const samples = [...frames.values()];
  assert.ok(end.position[2] - z0 >= 1000);
  assert.equal(samples.length, samples.at(-1).seq - firstSeq, 'polling must capture every frame');
  assert.equal(end.chunks, 81); assert.ok(end.animals.length <= 12);
  await page.screenshot({ path: join(out, 'kilometre.png') });
  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfter = await cdp.send('Runtime.getHeapUsage');
  await delay(11000);
  const still = await read();
  const stillMs = summary(still.intervals.slice(-12));
  assert.ok(stillMs.p50 >= 180);
  const pose = async detail => {
    await page.evaluate(detail => dispatchEvent(new CustomEvent('wilds-measure-pose', { detail })), detail);
    await page.waitForFunction(() => window.__wilds.read().pending === 0);
    await delay(1800);
  };
  await pose({ x: 0, z: 200, yaw: Math.PI, pitch: -.16 });
  await page.screenshot({ path: join(out, 'near.png') });
  const clips = [];
  for (const kind of ['deer', 'rabbit', 'bird', 'duck']) {
    await pose({ x: 0, z: 200, yaw: Math.PI, pitch: -.16 });
    if (kind === 'duck') {
      const bounds = planBuilding([], [], []).bounds;
      let duck;
      for (let z = 60; z < 1000 && !duck; z += 16) for (let x = -96; x < 96 && !duck; x += 16) {
        duck = populate([], x, z, bounds).find(a => a.kind === 'duck');
      }
      assert.ok(duck); await pose({ x: duck.homeX, z: duck.homeZ, yaw: Math.PI, pitch: -.16 });
    }
    const animal = (await read()).animals.find(a => a.kind === kind);
    assert.ok(animal, `generated ${kind} must be present`);
    // Side-on, beyond flee radius, using the actual population, not synthetic models.
    await pose({ x: animal.x + 7, z: animal.z + 3, yaw: Math.atan2(-7, 3), pitch: kind === 'bird' ? .35 : -.12 });
    await page.screenshot({ path: join(out, `${kind}.png`) });
    if (process.env.WILDS_VIDEO) {
      let n = 0;
      const pending = [], timing = [];
      const listener = ({ data, sessionId, metadata }) => {
        const file = `${kind}-${String(n++).padStart(4, '0')}.jpg`;
        timing.push({ file, time: metadata.timestamp });
        pending.push(writeFile(join(out, file), Buffer.from(data, 'base64')));
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      };
      cdp.on('Page.screencastFrame', listener);
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1 });
      // Moving the view keeps wildlife updating at the walk rate; still views remain 5 Hz.
      await page.keyboard.down('a'); await delay(1600); await page.keyboard.up('a'); await delay(400);
      await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', listener); await Promise.all(pending);
      await writeFile(join(out, `${kind}-timing.json`), JSON.stringify(timing));
      clips.push(kind);
    }
  }
  let officeCheck;
  if (process.env.WILDS_RUN !== 'before') {
    await pose({ x: 0, z: 60, yaw: 0, pitch: -.12 });
    const facing = await read(); assert.equal(facing.officeVisible, true);
    await page.screenshot({ path: join(out, 'office-facing.png') });
    await pose({ x: 0, z: 60, yaw: Math.PI, pitch: -.12 });
    const away = await read(); assert.equal(away.officeVisible, false);
    officeCheck = { facingCalls: facing.calls, awayCalls: away.calls };
    await page.getByRole('button', { name: 'Your desk' }).click(); await delay(2000);
    assert.equal((await read()).officeVisible, true);
    await page.screenshot({ path: join(out, 'home.png') });
    assert.ok(summary(samples.map(f => f.interval)).p95 < 35, 'outdoor motion must not regress to office pacing');
    assert.ok(Math.max(...samples.map(f => f.interval)) < 100, 'no long outdoor hitches');
  }
  assert.deepEqual(errors, []);
  const result = { date: new Date().toISOString(), browser: await browser.version(), viewport: '1440x1000 DPR1', method: 'Built production, headless Chromium ANGLE Metal; empty scratch Building; real Shift+W 9 m/s for 1 km; every rendered frame retained, no GC/screenshots/teleports during measured walk. CPU is callback-through-render submission, not GPU timing.', distance: end.position[2] - z0, clips, officeCheck, intervalMs: summary(samples.map(f => f.interval)), cpuMs: summary(samples.map(f => f.cpu)), swapIntervalMs: summary(samples.filter(f => f.swaps).map(f => f.interval)), rebuildMs: summary(samples.filter(f => f.rebuildMs).map(f => f.rebuildMs)), installMs: summary(samples.filter(f => f.installMs).map(f => f.installMs)), calls: summary(samples.map(f => f.calls)), triangles: summary(samples.map(f => f.triangles)), hitchesOver100: samples.filter(f => f.interval > 100).length, worst: [...samples].sort((a,b) => b.interval-a.interval).slice(0, 15), heapBefore, heapAfter, final: { chunks: end.chunks, geometries: end.geometries, terrainSlots: end.terrainSlots, instanceBatches: end.instanceBatches }, stillMs, errors };
  await writeFile(join(out, 'measurements.json'), JSON.stringify(result, null, 2));
  await writeFile(join(out, 'frames.json'), JSON.stringify(samples));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  if (office.exitCode === null) { office.kill('SIGTERM'); await new Promise(r => office.once('exit', r)); }
  await rm(home, { recursive: true, force: true });
}
