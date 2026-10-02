// Every physical seat has an approach, including unoccupied/decorative chairs. This inventory
// lets the reachability check cover seats that currently have no agent assigned to them.
import { benchSeats, doorway, isBuilding, place, readingNooks, seatSpot } from "./building.ts";
import { seatsInLounge } from "./games.ts";
import { type OfficePlan, type Spot, type Vec2 } from "./layout.ts";
export interface Seat { id: string; spot: Spot }
export function allSeats(plan: OfficePlan): Seat[] {
  const seats: Seat[] = seatsInLounge(plan).map((spot,i)=>({id:`lounge:${i}`,spot}));
  // Craft stations replaced desk chairs; occupied station places still get checked.
  for(const [id,spot] of plan.spots) if(spot.zone==="team") seats.push({id:`station:${id}`,spot});
  if(!isBuilding(plan))return seats;
  readingNooks(plan).forEach((n,i)=>n.seats.forEach((spot,k)=>seats.push({id:`nook:${i}:${k}`,spot})));
  benchSeats(plan.garden).forEach((s,i)=>seats.push({id:`bench:${i}`,spot:seatSpot(plan.garden,plan.loop,s)}));
  plan.rooms.filter(r=>r.kind==="meeting").forEach((room,i)=>{
    const length=Math.max(2,Math.min(4.2,2*room.half[1]-3.4)), n=Math.max(2,Math.floor(length/0.9)), d=doorway(room,0);
    const at=(x:number,z:number)=>place(room.center,room.facing,[x,z]);
    for(const side of [-1,1])for(let k=0;k<n;k++) {
      const z=-0.3-length/2+(k+0.5)*length/n;
      seats.push({id:`meeting:${i}:${side}:${k}`,spot:{pos:at(side*0.95,z),facing:room.facing-side*Math.PI/2,zone:"lounge",group:`meeting:${i}`,sit:true,
        approach:[d.out,d.inside,at(side*1.85,room.half[1]-0.6),at(side*1.85,z)]}});
    }
  });
  const room=plan.rooms.find(r=>r.kind==="lounge")!, d=doorway(room,0), tx=room.half[0]-1.9, tz=0.33-room.half[1]+1.65;
  const at=(x:number,z:number)=>place(room.center,room.facing,[x,z]);
  for(const dz of [-0.6,0.6])for(const dx of [-0.5,0.5])seats.push({id:`stool:${dx}:${dz}`,spot:{pos:at(tx+dx,tz+dz),facing:room.facing+(dz>0?Math.PI:0),zone:"lounge",group:"lounge",sit:true,
    approach:[d.out,d.inside,at(room.half[0]-0.8,3.8),at(room.half[0]-0.8,tz+Math.sign(dz)*1.03),at(tx+dx,tz+Math.sign(dz)*1.03)]}});
  const {x,z}=plan.frontDoor;
  const pos:Vec2=[x+1.54,z-3];
  seats.push({id:"reception",spot:{pos,facing:-Math.PI/2,zone:"lounge",group:"reception",sit:true,approach:[[x,plan.loop.maxZ],[x+1.54,plan.loop.maxZ],[x+1.54,z-4.8]]}});
  return seats;
}
