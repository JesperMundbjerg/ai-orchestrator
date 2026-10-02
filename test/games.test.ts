import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import { planOffice, type OfficePlan, type Vec2 } from "../src/ui/world/layout.ts";
import { isBuilding, planBuilding, place, readingNooks, routeIn } from "../src/ui/world/building.ts";
import { GamePlayback, bakePlays, chooseGames, gameSpots, PLAYS, playAt, type GameSeat } from "../src/ui/world/games.ts";
import { allSeats } from "../src/ui/world/seats.ts";
import { COFFEE, COUCHES, DARTS, POOL } from "../src/ui/world/lounge.ts";
const agent=(id:string,extra:Partial<WorldAgent>={}):WorldAgent=>({id,identity:id,name:id,harness:"manual",cwd:null,project:null,branch:null,status:"idle",title:null,paneId:null,taskIds:[],teamId:null,role:"member",waitingOnYou:false,doing:null,helpers:[],model:null,sessionName:null,ran:true,...extra});
const team=(id:string):Team=>({id,name:id,purpose:"",handsTo:null,path:null,branch:null,standing:true,worktrees:[],createdAt:""});
test("plays are deterministic, bounded baked frames with pots, misses and three landed darts",()=>{
  assert.deepEqual(bakePlays(),PLAYS);
  assert.equal(PLAYS.pool.length,6);
  for(const frames of PLAYS.pool) {
    assert.ok(frames.some(f=>f.lean>0.5));
    assert.notDeepEqual(frames[0]!.balls,frames[100]!.balls);
    for(const f of frames) for(const [x,y,z] of f.balls) assert.ok(Math.abs(x)<=0.65&&Math.abs(z)<=1.25&&y>=0.83);
  }
  assert.ok(PLAYS.pool.some(p=>p.at(-1)!.score==="POT!"));
  assert.ok(PLAYS.pool.some(p=>p.at(-1)!.score==="Just missed"));
  for(const frames of PLAYS.darts){assert.equal(frames.at(-1)!.darts.length,3);assert.match(frames.at(-1)!.score,/points/);assert.ok(frames[30]!.darts[0]![2]<2.35);}
  const s:GameSeat={kind:"pool",seed:9,start:1000,player:0};
  assert.equal(playAt(s,999).active,false);
  assert.equal(playAt(s,1000).player,0);assert.equal(playAt(s,9000).player,1);assert.equal(playAt(s,17000).player,0);
  assert.deepEqual(playAt(s,4800),playAt(s,4800));
});
test("both layouts keep two pool players and one darts player; status/queue changes release them immediately",()=>{
  for(const make of [planOffice,planBuilding]) {
    const agents=Array.from({length:9},(_,i)=>agent(`idle${i}`,{teamId:"t"})), since=new Map(agents.map(a=>[a.id,0]));
    const plan=make(agents,[team("t")],[]);
    assert.equal(chooseGames(plan,agents,since,59_999).size,0);
    const first=chooseGames(plan,agents,since,60_000);
    assert.equal(first.size,3);assert.equal([...first.values()].filter(s=>s.game?.kind==="pool").length,2);
    assert.deepEqual(chooseGames(plan,[...agents].reverse(),since,61_000,first),first);
    const ids=[...first.keys()];
    for(const status of ["working","blocked","done","offline"] as const) {
      const next=chooseGames(plan,agents.map(a=>ids.includes(a.id)?{...a,status}:a),since,62_000,first);
      assert.ok(ids.every(id=>!next.has(id)));assert.equal(next.size,3);
    }
    assert.ok(!chooseGames({...plan,queue:[ids[0]!]},agents,since,62_000,first).has(ids[0]!));
    assert.equal(chooseGames(plan,[],since,62_000,first).size,0);
    const one=chooseGames(plan,[agents[0]!],since,62_000);assert.equal([...one.values()][0]!.game!.kind,"darts");
  }
});
test("playback waits for actual arrival, alternates the pair, and stops on departure",()=>{
  const seat:GameSeat={kind:"pool",seed:1,start:0,player:0};
  const game=new GamePlayback(new Map([["a",seat],["b",{...seat,player:1}]]));
  assert.equal(game.frame(seat,1000),null);
  game.arrive("a",true);assert.equal(game.frame(seat,2000),null);
  game.arrive("b",true);assert.equal(game.frame(seat,30_000)!.player,0);
  assert.equal(game.frame(seat,38_000)!.player,1);
  game.arrive("b",false);assert.equal(game.frame(seat,38_001),null);
  const lone=new GamePlayback(new Map([["a",seat]]));lone.arrive("a",true);assert.equal(lone.frame(seat,40_000),null);
  const dart:GameSeat={...seat,kind:"darts"};const solo=new GamePlayback(new Map([["a",dart]]));
  solo.arrive("a",true);assert.equal(solo.frame(dart,1000)!.active,true);
});
interface Block {id:string; center:Vec2; half:Vec2; facing:number; seat?:boolean}
function blocks(plan:OfficePlan):Block[]{
  const out:Block[]=[];
  const add=(id:string,center:Vec2,half:Vec2,facing=0,seat=false)=>out.push({id,center,half,facing,seat});
  const lounge=plan.lounge, at=(p:Vec2)=>place(lounge.center,lounge.facing,p);
  COUCHES.forEach((c,i)=>add(`sofa:${i}`,at(c.pos),[c.width/2,0.44],lounge.facing+c.facing,true));
  add("coffee",at(COFFEE),[0.3,0.3],lounge.facing);
  add("pool",at(POOL),[0.825,1.475],lounge.facing);
  add("dartboard",at([DARTS[0],DARTS[1]-0.12]),[0.675,0.08],lounge.facing);
  for(const c of plan.corners)for(const d of c.desks)add("desk",d.pos,[d.kind==="lead"?1:0.7*d.scale,0.35*d.scale],d.facing);
  if(isBuilding(plan)) {
    for(const w of plan.walls){const dx=w.b[0]-w.a[0],dz=w.b[1]-w.a[1];add("wall",[(w.a[0]+w.b[0])/2,(w.a[1]+w.b[1])/2],[Math.hypot(dx,dz)/2,w.kind==="planter"?0.19:w.kind==="glass"?0.04:0.15],Math.atan2(-dz,dx));}
    for(const b of plan.garden.beds)add("bed",[(b.minX+b.maxX)/2,(b.minZ+b.maxZ)/2],[(b.maxX-b.minX)/2,(b.maxZ-b.minZ)/2]);
    for(const n of readingNooks(plan)) {
      add("nook sofa",n.center,[1,0.44],n.facing,true);
      add("nook table",place(n.center,n.facing,[0,1.6]),[0.45,0.3],n.facing);
      for(const x of [-1.6,1.6])add("nook plant",place(n.center,n.facing,[x,-0.8]),[0.35,0.35],n.facing);
    }
    for(const r of plan.rooms) {
      const a=(p:Vec2)=>place(r.center,r.facing,p), [hw,hd]=r.half;
      if(r.kind==="meeting")add("meeting table",a([0,-0.3]),[0.65,Math.max(2,Math.min(4.2,2*hd-3.4))/2],r.facing);
      if(r.kind==="lounge") {
        const back=0.33-hd, run=hw-3.1;
        add("kitchen",a([2.3+run/2,back]),[run/2,0.33],r.facing);
        add("fridge",a([hw-0.42,back+0.05]),[0.36,0.35],r.facing);
        add("high table",a([hw-1.9,back+1.65]),[0.8,0.35],r.facing);
        for(const z of [0.6-hd,hd-1.4])add("lounge plant",a([0.8-hw,z]),[0.35,0.35],r.facing);
      }
    }
    add("reception",[plan.frontDoor.x+0.9,plan.frontDoor.z-3.2],[0.37,1.15]);
  }
  for(const s of allSeats(plan))if(s.spot.sit&&!s.id.startsWith("lounge")&&!s.id.startsWith("nook"))add(s.id,s.spot.pos,[s.id.startsWith("stool")?0.19:0.25,s.id.startsWith("stool")?0.19:0.24],s.spot.facing,true);
  return out;
}
function distance(b:Block,p:Vec2){const q=place([0,0],-b.facing,[p[0]-b.center[0],p[1]-b.center[1]]);return Math.hypot(Math.max(0,Math.abs(q[0])-b.half[0]),Math.max(0,Math.abs(q[1])-b.half[1]));}
test("every seat and game position in both layouts has a clear entrance path, including all four sealed-corner regressions",()=>{
  for(const make of [planBuilding,planOffice])for(const count of [0,3,12]) {
    const teams=Array.from({length:count},(_,i)=>team(`t${i}`));
    const agents=teams.flatMap(t=>Array.from({length:count===12?18:9},(_,i)=>agent(`${t.id}:${i}`,{teamId:t.id,role:i===0?"lead":"member"})));
    const plan=make(agents,teams,[]), obstacles=blocks(plan), seats=allSeats(plan);
    if(isBuilding(plan))assert.equal(seats.filter(s=>s.id.startsWith("nook")).length,8);
    for(const {id,spot} of [...seats,...gameSpots(plan).map((spot,i)=>({id:`game:${i}`,spot}))]) {
      const path=[plan.entrance,...routeIn(plan)(plan.entrance,null,spot)];
      for(let i=1;i<path.length;i++) {
        const a=path[i-1]!,b=path[i]!,n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/0.08));
        const nearby=obstacles.filter(ob=>Math.hypot(ob.center[0]-(a[0]+b[0])/2,ob.center[1]-(a[1]+b[1])/2)<Math.hypot(b[0]-a[0],b[1]-a[1])/2+Math.hypot(...ob.half)+0.3);
        for(let k=0;k<=n;k++) {
          const p:Vec2=[a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n];
          for(const ob of nearby) {
            // Only the destination seat can be entered, on the final sit-down step.
            if(ob.seat&&distance(ob,spot.pos)<0.01&&i===path.length-1)continue;
            if(distance(ob,p)<0.215) assert.fail(`${isBuilding(plan)?"building":"ring"}/${count} ${id}: ${p} hits ${ob.id} at ${ob.center}`);
          }
        }
      }
    }
  }
});
