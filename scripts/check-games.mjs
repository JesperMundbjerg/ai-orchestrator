// Disposable HTTP office + headless Chromium. Never reads live office/herdr/account state.
// PLAYWRIGHT_MODULE='/absolute/path/to/playwright/index.mjs' node scripts/check-games.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { planBuilding, place, readingNooks } from '../src/ui/world/building.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath=chromium.executablePath();
const output=process.env.GAMES_SCREENSHOTS || join(homedir(), '.review-inbox/handoffs/agent-office/games');
const home=mkdtempSync(join(tmpdir(),'office-games-'));
process.env.HOME=home; process.env.INBOX_DATA_DIR=join(home,'data');
process.env.HERDR_SOCKET_PATH='/nonexistent';
process.env.HERDR_BIN_PATH='/usr/bin/false';
const { openDatabase }=await import('../src/server/db.ts');
const { Inbox }=await import('../src/server/inbox.ts');
const { createInboxServer }=await import('../src/server/http.ts');
const db=openDatabase(join(home,'inbox.sqlite'));
const inbox=new Inbox(db,join(home,'files'),{available:()=>false,forSession:()=>null,resolvePane:()=>null});
const teams=[{id:'studio',name:'Games check',purpose:'',standing:true,path:null,worktrees:[],branch:null,handsTo:null,createdAt:'',status:'idle',blockedBy:[]}];
const agents=Array.from({length:23},(_,i)=>({id:`idle-${i}`,identity:`idle-${i}`,name:['Ada','Bo','Clara','Dara','Eli','Finn','Gia','Hugo','Iris','Jude','Kai','Lena','Milo','Nora','Otto'][i]??`Guest ${i}`,harness:'manual',cwd:null,project:null,branch:null,status:'idle',title:null,paneId:null,taskIds:[],teamId:'studio',role:i?'member':'lead',waitingOnYou:false,doing:null,helpers:[],model:null,sessionName:null,ran:true}));
const worldState={teams,agents,messages:[],withFounder:[],work:[],repositories:[],herdr:'unavailable'};
const world={state:()=>worldState,react:async()=>{},onChange:()=>{}};
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));assert.notEqual(port,4870);
const server=createInboxServer(inbox,null,{port,staticDir:resolve('dist'),world});await new Promise(r=>server.listen(port,'127.0.0.1',r));
let browser;
try {
  mkdirSync(output,{recursive:true});
  browser=await chromium.launch({headless:true,executablePath,args:['--use-angle=metal']});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.__roots=new Set();window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberRoot:(_,r)=>window.__roots.add(r),onCommitFiberUnmount:()=>{}};
    const realNow=Date.now; Date.now=()=>window.__gameNow??realNow();
    window.__scene=()=>{
      let store,view,games,plan;const avatars=new Map();
      const visit=f=>{if(!f)return;const p=f.memoizedProps;
        if(p?.plan?.rooms)plan=p.plan;
        if(p?.value?.getState&&p.value.getState()?.scene)store=p.value.getState();
        if(p?.value?.ready instanceof Set&&p.value.starts instanceof Map)games=p.value;
        if(p?.agent&&p?.spot)avatars.set(p.agent.id,{id:p.agent.id,status:p.agent.status,spot:p.spot});
        let h=f.memoizedState;while(h&&typeof h==='object'){const v=h.memoizedState?.current;if(v&&typeof v.eye==='number'&&typeof v.yaw==='number'&&typeof v.fov==='number')view=v;h=h.next;}
        visit(f.child);visit(f.sibling);
      };for(const r of window.__roots)visit(r.current);return {store,view,games,plan,avatars:[...avatars.values()]};
    };
  });
  await page.goto(`http://localhost:${port}/#/world`);
  await page.waitForFunction(()=>!!window.__scene().store&&!!window.__scene().view);
  const assertBuilding = async () => {
    assert.equal(await page.getByRole('group', { name: 'Office layout' }).count(), 0);
    for (const name of ['Ring', 'Building', 'Your desk']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__scene().plan.rooms.filter(r => r.kind === 'meeting').length), 2);
    assert.ok(await page.evaluate(() => window.__scene().plan.garden.benches.length > 0));
  };
  await assertBuilding();
  // Legacy browser preferences never select another office or get rewritten.
  await page.evaluate(() => localStorage.setItem('review-inbox.office-layout', 'ring'));
  await page.reload();
  await page.waitForFunction(()=>!!window.__scene().store&&!!window.__scene().view);
  await assertBuilding();
  assert.equal(await page.evaluate(() => localStorage.getItem('review-inbox.office-layout')), 'ring');
  await page.waitForTimeout(1200);
  await page.screenshot({path:join(output,'building-opening-no-selector.png')});
  const view=async(center,facing,{distance=8,side=0,pitch=-0.55,lift=0.1,fov=62}={})=>{
    const [x,z]=place(center,facing,[side,distance]);
    await page.evaluate(v=>{const s=window.__scene();Object.assign(s.view,v);s.store.invalidate();},{x,z,yaw:Math.atan2(center[0]-x,z-center[1]),pitch,lift,fov});
    await page.waitForTimeout(1100);
  };
  // Building-only: no dependency on the old layout selector surviving its removal.
  {
    const layout='building';
    await page.waitForTimeout(1200);
    const plan=planBuilding(agents,teams,[]);
    assert.ok(await page.evaluate(() => window.__scene().avatars.some(a => a.spot.zone === 'garden')), 'idle overflow still visits the garden');
    await view([0,-3],0,{distance:12,pitch:-0.85,lift:0.5,fov:72});
    await page.screenshot({path:join(output,'building-garden.png')});
    const players=await page.evaluate(()=>window.__scene().avatars.filter(a=>a.spot.game));
    assert.equal(players.length,3);
    await page.waitForFunction(()=>window.__scene().games?.starts.size===2);
    const starts=await page.evaluate(()=>[...window.__scene().games.starts]);
    const poolStart=starts.find(([key])=>key.startsWith('pool:'))[1];
    const dartsStart=starts.find(([key])=>key.startsWith('darts:'))[1];
    await page.evaluate(t=>{window.__gameNow=t;},poolStart+1500);
    await view(plan.lounge.center,plan.lounge.facing);
    await page.screenshot({path:join(output,`${layout}-lounge-couches.png`)});
    await view(place(plan.lounge.center,plan.lounge.facing,[0.2,-1]),plan.lounge.facing,{distance:6.5,side:3,pitch:-0.47,lift:0.08,fov:55});
    await page.screenshot({path:join(output,`${layout}-pool-strike.png`)});
    const before=await page.evaluate(()=>{const s=window.__scene().store.scene;return {ball:s.getObjectByName('pool-ball:0').position.toArray(),cue:s.getObjectByName('pool-cue').visible};});
    assert.equal(before.cue,true);
    await page.evaluate(t=>{window.__gameNow=t;},poolStart+3800);
    await page.waitForTimeout(400);
    await page.screenshot({path:join(output,`${layout}-pool-roll.png`)});
    const after=await page.evaluate(()=>window.__scene().store.scene.getObjectByName('pool-ball:0').position.toArray());
    assert.notDeepEqual(after,before.ball);
    await page.evaluate(t=>{window.__gameNow=t;},dartsStart+1100);
    await view(place(plan.lounge.center,plan.lounge.facing,[3.1,0.8]),plan.lounge.facing,{distance:6.5,side:2.8,pitch:-0.28,lift:0.055,fov:52});
    await page.screenshot({path:join(output,`${layout}-darts-throw.png`)});
    await page.evaluate(t=>{window.__gameNow=t;},dartsStart+8500);
    await page.waitForTimeout(400);
    await page.screenshot({path:join(output,`${layout}-darts-score.png`)});
    assert.equal(await page.evaluate(()=>{const d=window.__scene().store.scene.getObjectByName('lounge-darts');return [0,1,2].every(i=>d.getObjectByName(`dart:${i}`).visible)&&d.getObjectByName('game-score').children.some(c=>c.visible);}),true);
    for(const [i,n] of readingNooks(plan).entries()) {
      await view(n.center,n.facing,{distance:5.8,pitch:-0.5,lift:0.08,fov:60});
      await page.screenshot({path:join(output,`building-corner-couch-${i+1}.png`)});
    }
  }
  // The same live SSE update that starts work must remove game assignments immediately.
  await page.evaluate(()=>{delete window.__gameNow;});
  const active=await page.evaluate(()=>window.__scene().avatars.filter(a=>a.spot.game).map(a=>a.id));
  agents.forEach(a=>{a.status='working';});world.onChange('world');
  await page.waitForFunction(()=>window.__scene().avatars.every(a=>a.status==='working'&&!a.spot.game));
  assert.equal(active.length,3);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>window.__scene().store.scene.getObjectByName('pool-cue').visible),false);
  assert.equal(await page.evaluate(()=>[0,1,2].some(i=>window.__scene().store.scene.getObjectByName(`dart:${i}`).visible)),false);
  // Use the actual front-door button and keyboard, not the test camera, to leave and return.
  await page.getByRole('button', { name: 'Front door ↗', exact: true }).click();
  await page.waitForTimeout(1600);
  const doorZ = await page.evaluate(() => window.__scene().plan.frontDoor.z);
  assert.ok(Math.abs(await page.evaluate(() => window.__scene().view.z) - (doorZ - 2.5)) < 0.1);
  await page.screenshot({path:join(output,'building-front-door.png')});
  await page.keyboard.down('KeyW'); await page.waitForTimeout(2400); await page.keyboard.up('KeyW');
  assert.ok(await page.evaluate(() => window.__scene().view.z) > doorZ + 4, 'walks outside through the open door');
  await page.screenshot({path:join(output,'building-outside.png')});
  await page.keyboard.down('KeyS'); await page.waitForTimeout(2600); await page.keyboard.up('KeyS');
  assert.ok(await page.evaluate(() => window.__scene().view.z) < doorZ, 'walks back inside');
  assert.deepEqual(errors,[]);
  console.log(`Headless checked default/legacy Building with no selector or founder desk, garden, front door, idle games, all corner couches and immediate work exit. Scratch port ${port}; screenshots ${output}`);
} finally {
  await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(home,{recursive:true,force:true});
}
