import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { Helper } from "../../shared/types.ts";
import { Body } from "./Avatar.tsx";
import { textTexture } from "./label.ts";
import type { Spot } from "./spatial.ts";
import { lookFor } from "./look.ts";

/**
 * The sub-agents an agent has running, as small people standing behind it for as long as they
 * work. They carry no lamp: they belong to the agent, whose lamp says how it goes.
 */
export function Helpers({ helpers, spot }: { helpers: Helper[]; spot: Spot }) {
  const [x, z] = spot.pos;
  const f = spot.facing;
  return (
    <group>
      {helpers.map((h, i) => {
        // A row behind the agent, centred on it; every other tag a little higher so they do not cover each other.
        const side = (i - (helpers.length - 1) / 2) * 0.6;
        const pos: [number, number, number] = [x - Math.sin(f) * 0.85 + Math.cos(f) * side, 0, z - Math.cos(f) * 0.85 - Math.sin(f) * side];
        return <HelperFigure key={h.id} helper={h} position={pos} facing={f} tagY={i % 2 ? 1.62 : 1.4} />;
      })}
    </group>
  );
}

function HelperFigure({ helper, position, facing, tagY }: { helper: Helper; position: [number, number, number]; facing: number; tagY: number }) {
  const look = useMemo(() => lookFor(helper.id), [helper.id]);
  const root = useRef<Group>(null);
  const legs = useRef<[Group | null, Group | null]>([null, null]);
  const arms = useRef<[Group | null, Group | null]>([null, null]);
  const phase = useMemo(() => Math.random() * 10, []);
  const tagWidth = Math.min(640, 60 + helper.type.length * 19);
  const tag = useMemo(
    () => textTexture([{ text: helper.type, size: 34, color: "#ffffff", weight: 600 }], { width: tagWidth, height: 64, background: "rgba(16,20,28,0.6)", radius: 30 }),
    [helper.type],
  );
  useEffect(() => () => tag.dispose(), [tag]);

  useFrame((state) => {
    const t = state.clock.elapsedTime + phase;
    if (root.current) root.current.position.y = Math.abs(Math.sin(t * 2.2)) * 0.03;
    // Busy hands: they are working on something for the agent.
    const [al, ar] = arms.current;
    if (al && ar) {
      al.rotation.x = -0.9 + Math.sin(t * 7) * 0.12;
      ar.rotation.x = -0.9 + Math.sin(t * 7 + 1.4) * 0.12;
    }
  });

  return (
    <group position={position} rotation-y={facing}>
      <group ref={root} scale={0.62 * look.height}>
        <Body look={look} legs={legs} arms={arms} card={null} />
      </group>
      <sprite position={[0, tagY, 0]} scale={[(tagWidth / 64) * 0.15, 0.15, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}
