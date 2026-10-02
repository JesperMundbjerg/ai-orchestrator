import { createContext, useContext, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh } from "three";
import type { BuildingPlan } from "./building.ts";
import { DARTS, POOL } from "./lounge.ts";
import { PLAYS, type GamePlayback, type GameSeat } from "./games.ts";
export const GameContext = createContext<GamePlayback | null>(null);
export const useGames = () => useContext(GameContext);
import { usePace } from "./Pace.tsx";
import { textTexture } from "./label.ts";
import { useTexture } from "./useTexture.ts";

function Box({ at, size, color }: { at: [number,number,number]; size: [number,number,number]; color: string }) {
  return <mesh position={at} castShadow receiveShadow><boxGeometry args={size}/><meshStandardMaterial color={color} roughness={0.8}/></mesh>;
}
/** Always present furniture; only the active game asks the pacer for animation. */
export function GamesScene({ plan }: { plan: BuildingPlan }) {
  const playing=[...plan.spots.values()].flatMap(s=>s.game?[s.game]:[]);
  const pool=playing.filter(g=>g.kind==="pool");
  const darts=playing.find(g=>g.kind==="darts");
  return <group position={[plan.lounge.center[0],0,plan.lounge.center[1]]} rotation-y={plan.lounge.facing}>
    <group name="lounge-pool" position={[POOL[0],0,POOL[1]]}>
      <Box at={[0,0.77,0]} size={[1.65,0.3,2.95]} color="#654536"/>
      <Box at={[0,0.945,0]} size={[1.35,0.04,2.65]} color="#237c67"/>
      {[-1,1].flatMap(x=>[-1,1].map(z=><Box key={`${x}:${z}`} at={[x*0.6,0.35,z*1.15]} size={[0.18,0.7,0.18]} color="#493c35"/>))}
      {[-1,1].flatMap(x=>[-1,0,1].map(z=><mesh key={`${x}:${z}`} position={[x*0.65,0.975,z*1.27]} rotation-x={-Math.PI/2}><circleGeometry args={[0.115,10]}/><meshStandardMaterial color="#111a1a"/></mesh>))}
      <PoolPlay seat={pool.length===2?pool[0]!:null}/>
    </group>
    <group name="lounge-darts" position={[DARTS[0],0,DARTS[1]]}>
      <Box at={[0,1.35,-0.12]} size={[1.35,2.7,0.16]} color="#735744"/>
      <mesh position={[0,1.75,0]}><circleGeometry args={[0.53,20]}/><meshStandardMaterial color="#d6c7a4"/></mesh>
      {Array.from({length:20},(_,i)=><mesh key={i} position={[0,1.75,0.012]} rotation-z={i*Math.PI/10}><circleGeometry args={[0.47,1,0,Math.PI/10]}/><meshStandardMaterial color={i%2?"#e8dfca":"#25312e"}/></mesh>)}
      {[0.3,0.45].map(r=><mesh key={r} position={[0,1.75,0.018]}><ringGeometry args={[r-0.025,r,40]}/><meshStandardMaterial color="#b14a42"/></mesh>)}
      <mesh position={[0,1.75,0.022]}><circleGeometry args={[0.04,10]}/><meshStandardMaterial color="#e84e45"/></mesh>
      <Box at={[0,0.012,2.35]} size={[1.1,0.02,0.045]} color="#e8ca7d"/>
      <DartPlay seat={darts??null}/>
    </group>
  </group>;
}
function Score({ text, visible }: {text:string; visible:boolean}) {
  const texture=useTexture(()=>textTexture([{text,size:44,color:"#ffe2a1",weight:800}],{width:320,height:80,background:"#243b36",radius:12}),[text]);
  return <sprite visible={visible} position={[0,2.95,0]} scale={[1.5,0.375,1]}><spriteMaterial map={texture} depthWrite={false}/></sprite>;
}
// Every possible score has a cached sprite; frames only toggle visibility, not React state/textures.
function Scores({ seat, kind }: {seat:GameSeat|null; kind:GameSeat["kind"]}) {
  const root=useRef<Group>(null), games=useGames();
  const labels=useMemo(()=>[...new Set(PLAYS[kind].flatMap(play=>play.map(frame=>frame.score)))].filter(Boolean),[kind]);
  useFrame(()=>{const p=seat?games?.frame(seat,Date.now()):null; root.current?.children.forEach((g,i)=>g.visible=!!p?.active&&p.score===labels[i]);});
  return <group name="game-score" ref={root}>{labels.map(text=><Score key={text} text={text} visible={false}/>)}</group>;
}
function PoolPlay({seat}:{seat:GameSeat|null}) {
  const balls=useRef<Array<Mesh|null>>([]), cue=useRef<Group>(null), pace=usePace(), games=useGames();
  useFrame(()=>{
    const p=seat?games?.frame(seat,Date.now()):null;
    if(p?.active)pace?.moved(performance.now());
    const sign=p?.player===1?-1:1;
    balls.current.forEach((b,i)=>{if(!b)return;const q=p?.active?p.balls[i]!:[i*0.2,1.03,i?0:0.7];b.position.set(q[0]!*sign,q[1]!,q[2]!*sign);});
    if(cue.current){cue.current.visible=!!p?.active&&p.lean>0;cue.current.rotation.y=sign===1?0:Math.PI;cue.current.position.z=sign*(1.15+(p?.cue??0));}
  });
  return <>
    {["#f5efe1","#e5a038"].map((c,i)=><mesh name={`pool-ball:${i}`} key={c} ref={m=>{balls.current[i]=m;}}><sphereGeometry args={[0.065,10,8]}/><meshStandardMaterial color={c} roughness={0.35}/></mesh>)}
    <group name="pool-cue" ref={cue} visible={false}><mesh position={[0,1.05,0.3]} rotation-x={Math.PI/2}><cylinderGeometry args={[0.012,0.021,1.5,6]}/><meshStandardMaterial color="#d7b788"/></mesh></group>
    <Scores seat={seat} kind="pool"/>
  </>;
}
function DartPlay({seat}:{seat:GameSeat|null}) {
  const darts=useRef<Array<Group|null>>([]), pace=usePace(), games=useGames();
  useFrame(()=>{const p=seat?games?.frame(seat,Date.now()):null;if(p?.active)pace?.moved(performance.now());darts.current.forEach((g,i)=>{if(!g)return; const q=p?.active?p.darts[i]:null;g.visible=!!q;if(q)g.position.set(...q);});});
  return <>{[0,1,2].map(i=><group name={`dart:${i}`} key={i} ref={g=>{darts.current[i]=g;}} visible={false}>
    <Box at={[0,0,0.1]} size={[0.018,0.018,0.22]} color="#dce1e3"/>
    <Box at={[0,0,0.2]} size={[0.08,0.015,0.07]} color="#ebae48"/>
  </group>)}<Scores seat={seat} kind="darts"/></>;
}
