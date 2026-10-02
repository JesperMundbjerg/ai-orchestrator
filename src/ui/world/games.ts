// A tiny baked library, generated once. Playback is a frame lookup, never physics or random work.
import type { WorldAgent } from "../../shared/types.ts";
import { doorway, isBuilding } from "./building.ts";
import { type OfficePlan, type Spot, type Vec2 } from "./layout.ts";
import { DARTS, POOL, localPlace, loungeSeats } from "./lounge.ts";
import { hash, outForABreak } from "./park.ts";
export type V3 = [number, number, number];
export interface GameSeat { kind: "pool" | "darts"; seed: number; start: number; player: number }
export interface PlayFrame { balls: V3[]; darts: V3[]; lean: number; arm: number; cue: number; score: string }
export const PLAY_FPS = 20;
export const POOL_SECONDS = 8;
export const DART_SECONDS = 10;
const mix = (a: V3, b: V3, t: number): V3 => a.map((v,i) => v + (b[i]!-v)*t) as V3;
const clamp = (t: number) => Math.max(0,Math.min(1,t));
const path = (ps: V3[], t: number): V3 => { const n=clamp(t)*(ps.length-1), i=Math.min(ps.length-2,Math.floor(n)); return mix(ps[i]!, ps[i+1]!, n-i); };
export function bakePlays() {
  const pool = Array.from({length: 6}, (_,n) => {
    const pot = n%2===0, side = n%3===0 ? -1 : 1;
    const cue: V3[] = [[0,1.03,0.7],[0.1*side,1.03,0],[0.48*side,1.03,-0.45],[0.35*side,1.03,-0.6]];
    const ball: V3[] = [[0.1*side,1.03,0],[0.58*side,1.03,-0.6],pot ? [0.65*side,0.83,-1.25] : [-0.35*side,1.03,-0.85]];
    return Array.from({length: POOL_SECONDS*PLAY_FPS},(_,i): PlayFrame => {
      const t=i/PLAY_FPS;
      return { balls: [path(cue,(t-2)/2.4),path(ball,(t-2.5)/2.5)], darts: [], lean: t<2.4 ? 0.65*clamp(t/0.7) : 0,
        arm: t<2.4 ? -1.1 : 0, cue: t<2 ? -0.12*Math.sin(t*8) : t<2.4 ? 0.3 : 0, score: t>5.3 ? pot ? "POT!" : "Just missed" : "" };
    });
  });
  const darts = Array.from({length: 6},(_,n) => {
    const targets: V3[] = Array.from({length:3},(_,k) => [((n*7+k*3)%9-4)*0.065, 1.75+((n*3+k*7)%9-4)*0.065,0.05]);
    const scores = [20,5,60,1,50,18];
    return Array.from({length:DART_SECONDS*PLAY_FPS},(_,i): PlayFrame => {
      const t=i/PLAY_FPS, phase=t%2.5;
      const landed: V3[]=[];
      targets.forEach((p,k) => { const u=(t-(k*2.5+0.9))/0.45; if(u<0)return; const q=mix([-0.24,1.55,2.35],p,clamp(u)); q[1]+=Math.sin(clamp(u)*Math.PI)*0.4; landed.push(q); });
      return { balls:[], darts:landed, lean:0, arm:t<7.5 ? phase<0.9 ? -2.5 : phase<1.4 ? -1.35 : 0 : 0, cue:0,
        score:t>8 ? `${[0,1,2].reduce((s,k)=>s+scores[(n+k)%scores.length]!,0)} points` : "" };
    });
  });
  return {pool,darts};
}
export const PLAYS = bakePlays();
export function playAt(seat: GameSeat, now: number): PlayFrame & { active: boolean; player: number } {
  const seconds=(now-seat.start)/1000, duration=seat.kind==="pool" ? POOL_SECONDS : DART_SECONDS;
  const turn=Math.max(0,Math.floor(seconds/duration));
  const frames=PLAYS[seat.kind][hash(`${seat.seed}:${turn}`)%6]!;
  const frame=frames[Math.floor(Math.max(0,seconds)%duration*PLAY_FPS)]!;
  const player=seat.kind==="pool" ? turn%2 : 0;
  return {...frame, active:seconds>=0, player};
}
export function loungeEntry(plan: OfficePlan): Vec2[] {
  if(isBuilding(plan)) { const r=plan.rooms.find(r=>r.kind==="lounge")!, d=doorway(r,0); return [d.out,d.inside]; }
  return [localPlace(plan.lounge.center,plan.lounge.facing,[0,plan.ring-plan.path])];
}
export function gameSpots(plan: OfficePlan): Spot[] {
  const {center,facing}=plan.lounge, at=(p:Vec2)=>localPlace(center,facing,p), entry=loungeEntry(plan);
  return [0,1].map((i):Spot=>({pos:at([POOL[0],POOL[1]+(i===0?2:-2)]),facing:facing+(i===0?Math.PI:0),zone:"lounge",group:"lounge",
    approach:[...entry,at([1.65,3.4]),at([1.65,POOL[1]+(i===0?2:-2)])]})).concat([{pos:at([DARTS[0],DARTS[1]+2.35]),facing:facing+Math.PI,zone:"lounge",group:"lounge",approach:[...entry,at([1.65,3.4]),at([DARTS[0],3.4])]}]);
}
export type Games = Map<string, Spot>;
/** Retain players while eligible. Never reserve a table for one player, nor keep busy/queued people. */
export function chooseGames(plan: OfficePlan, agents: WorldAgent[], since: ReadonlyMap<string,number>, now: number, before: Games = new Map()): Games {
  const out=outForABreak(agents,since,now,plan.queue);
  const eligible=agents.filter(a=>a.status==="idle"&&!a.waitingOnYou&&!plan.queue.includes(a.id)&&(!a.teamId||out.has(a.id))).map(a=>a.id);
  const order=eligible.sort((a,b)=>hash(a)-hash(b)||a.localeCompare(b));
  const result:Games=new Map(), spots=gameSpots(plan);
  const retain=(kind:GameSeat["kind"], count:number) => {
    const old=[...before].filter(([id,s])=>eligible.includes(id)&&s.game?.kind===kind);
    if(old.length===count) for(const [id,s] of old) result.set(id,{...spots[kind==="pool"?s.game!.player:2]!,game:s.game});
  };
  retain("pool",2); retain("darts",1);
  const take=()=>order.filter(id=>!result.has(id));
  const start=(ids:string[],kind:GameSeat["kind"])=>{
    const seed=hash(ids.join(":"));
    ids.forEach((id,i)=>result.set(id,{...spots[kind==="pool"?i:2]!,game:{kind,seed,start:now,player:i}}));
  };
  if(![...result.values()].some(s=>s.game?.kind==="pool")&&take().length>=2) start(take().slice(0,2),"pool");
  if(![...result.values()].some(s=>s.game?.kind==="darts")&&take().length)start(take().slice(0,1),"darts");
  return result;
}
/** One scene's playback clock. Nothing starts until the actual walkers arrive. Leaving or a
 * visit cancels immediately; a lone pool player never strikes. No timers or physics. */
export class GamePlayback {
  players: ReadonlyMap<string, GameSeat>;
  ready = new Set<string>();
  starts = new Map<string, number>();
  constructor(players: ReadonlyMap<string, GameSeat>) { this.players = players; }
  key(seat: GameSeat): string { return `${seat.kind}:${seat.seed}:${seat.start}`; }
  arrive(id: string, ready: boolean): void {
    const seat = this.players.get(id);
    if (!seat) return;
    if (ready) this.ready.add(id);
    else { this.ready.delete(id); this.starts.delete(this.key(seat)); }
  }
  frame(seat: GameSeat, now: number): ReturnType<typeof playAt> | null {
    const key = this.key(seat), group = [...this.players].filter(([,s]) => this.key(s) === key);
    if (group.length !== (seat.kind === "pool" ? 2 : 1) || !group.every(([id]) => this.ready.has(id))) return null;
    if (!this.starts.has(key)) this.starts.set(key, now);
    return playAt({ ...seat, start: this.starts.get(key)! }, now);
  }
}

/** Real sofa seats for idle spectators, also used by the ring's initial layout. */
export const seatsInLounge = (plan:OfficePlan) => loungeSeats(plan.lounge.center,plan.lounge.facing,loungeEntry(plan));
