// Every character on the same ground steps in one loop, so they can land on
// each other and bump into each other. One ground per host element (or per
// document, for characters fixed to the viewport); it runs while it has
// members.

import { separate, type Life } from "./life";

export type Member = {
  life: Life;
  /** Draw this character after the step; `dt` in seconds. */
  frame(dt: number): void;
};

export type Ground = {
  /** Join; the reply leaves. */
  add(member: Member): () => void;
};

const grounds = new WeakMap<object, Ground>();

/** The ground for characters that share one: a host element, or the document for the viewport. */
export function groundFor(on: object): Ground {
  let ground = grounds.get(on);
  if (!ground) {
    ground = createGround();
    grounds.set(on, ground);
  }
  return ground;
}

function createGround(): Ground {
  const members = new Set<Member>();
  let frame: number | undefined;
  let last = 0;
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const lives = [...members].map((m) => m.life);
    for (const life of lives) life.step(now, dt, lives);
    separate(lives);
    for (const m of members) m.frame(dt);
    frame = members.size ? requestAnimationFrame(loop) : undefined;
  };
  return {
    add(member) {
      members.add(member);
      if (frame === undefined) {
        last = performance.now();
        frame = requestAnimationFrame(loop);
      }
      return () => {
        members.delete(member);
        if (members.size === 0 && frame !== undefined) {
          cancelAnimationFrame(frame);
          frame = undefined;
        }
      };
    },
  };
}
