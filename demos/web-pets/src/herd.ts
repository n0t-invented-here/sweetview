// Every pet on the same ground steps in one loop, so they can land on each
// other and bump into each other. One herd per host element (or per document, for pets fixed to the
// viewport); it runs while it has members.

import { separate, type Life } from "./life";

export type Member = {
  life: Life;
  /** Draw this pet after the step; `dt` in seconds. */
  frame(dt: number): void;
};

export type Herd = {
  /** Join; the reply leaves. */
  add(member: Member): () => void;
};

const herds = new WeakMap<object, Herd>();

/** The herd for pets that share this ground: a host element, or the document for the viewport. */
export function herdFor(ground: object): Herd {
  let herd = herds.get(ground);
  if (!herd) {
    herd = createHerd();
    herds.set(ground, herd);
  }
  return herd;
}

function createHerd(): Herd {
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
