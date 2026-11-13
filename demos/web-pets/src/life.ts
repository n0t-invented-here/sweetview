// The pet's little life, with no screen in it: a square box that falls,
// lands, walks and runs along the bottom edge of its bounds, turns at the
// sides, and can be picked up and thrown. Units are whatever the world's
// are (CSS pixels on a page); the page draws the model in the box.

import { type Command, type Direction, type Mood, nextCommand } from "./moods";
import type { Pet, PetAnimation } from "./pets";

export type Box = { x: number; y: number; width: number; height: number };

export type LifeState =
  | { kind: "ground"; mood: Mood; dir: Direction; until: number }
  | { kind: "fall"; vy: number }
  | { kind: "carried" }
  | { kind: "landed"; until: number };

/** What the life reads each step; every value may change between steps (a resize, a settings change). */
export type World = {
  /** Where the pet may be. The ground is the bottom edge. */
  bounds: () => Box;
  /** Edge of the pet's square box. */
  size: () => number;
  /** The model's scale: speeds follow it, so the stride matches the walk cycle at every size. */
  scale: () => number;
  /** Lift above the bounds' bottom edge. */
  bottom: () => number;
  /** Which pet this is, for the moods it may draw. */
  pet: () => Pet;
  /** What to do next on the ground; random by default. */
  nextCommand?: (pet: Pet) => Command;
};

export type Life = {
  /** The box's top-left. */
  readonly x: number;
  readonly y: number;
  readonly facing: Direction;
  readonly state: LifeState;
  /** The box's edge, as the world says. */
  readonly size: number;
  /** Where the box's top is when the pet stands on the ground. */
  groundY(): number;
  /** Put the box's top-left here and let the pet fall. */
  spawn(x: number, y: number): void;
  pickUp(): void;
  /** While carried: the box's new top-left. */
  carryTo(x: number, y: number): void;
  /** Turn to face this way; walking and running set it themselves. */
  face(dir: Direction): void;
  /** Let go, moving at this vertical speed (units per second, positive is down); clamped to a throw. */
  drop(vy: number): void;
  /** Pushed sideways by another pet, on the ground only; a walker pushed against its way turns around. The reply is how far it went (less than asked at a side edge). */
  bump(dx: number): number;
  /** Advance by `dt` seconds at time `now` (milliseconds, as `performance.now()`). */
  step(now: number, dt: number): void;
  /** The model animation for the current state, and its speed. */
  animation(): PetAnimation;
  animationSpeed(): number;
};

export const WALK_SPEED = 55; // units per second at scale 1, matched to the walk cycle
export const RUN_SPEED = 150;
export const GRAVITY = 2400;
export const MAX_THROW = 800;
const LANDED_MS = 1200; // the positive gesture after a landing
const REST_AFTER_LANDING_MS = 800;
/** How much of its box the pet may hang past a side edge: the model does not fill the square. */
const OVERHANG = 0.2;
/** How much of its box the pet's body fills, side to side, for bumping into other pets. */
export const BODY = 0.6;

const MOOD_ANIMATION: Record<Mood, PetAnimation> = { idle: "idle", walk: "walk", run: "run", eat: "eat", dance: "dance" };

export function createLife(world: World): Life {
  const pickNext = world.nextCommand ?? nextCommand;
  let x = 0;
  let y = 0;
  let facing: Direction = 1;
  let state: LifeState = { kind: "fall", vy: 0 };

  const groundY = () => {
    const b = world.bounds();
    return b.y + b.height - world.size() - world.bottom();
  };
  const sideLimits = () => {
    const b = world.bounds();
    const size = world.size();
    return { minX: b.x - size * OVERHANG, maxX: b.x + b.width - size * (1 - OVERHANG) };
  };
  const clampX = () => {
    const { minX, maxX } = sideLimits();
    x = Math.max(minX, Math.min(maxX, x));
  };
  const apply = (cmd: Command, now: number) => {
    state = { kind: "ground", mood: cmd.mood, dir: cmd.dir, until: now + cmd.seconds * 1000 };
    if (cmd.mood === "walk" || cmd.mood === "run") facing = cmd.dir;
  };

  return {
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    get facing() {
      return facing;
    },
    get state() {
      return state;
    },
    get size() {
      return world.size();
    },
    groundY,
    spawn(nx, ny) {
      x = nx;
      y = ny;
      clampX();
      state = { kind: "fall", vy: 0 };
    },
    pickUp() {
      state = { kind: "carried" };
    },
    carryTo(nx, ny) {
      if (state.kind !== "carried") return;
      x = nx;
      y = ny;
    },
    face(dir) {
      facing = dir;
    },
    drop(vy) {
      if (state.kind !== "carried") return;
      state = { kind: "fall", vy: Math.max(-MAX_THROW, Math.min(MAX_THROW, vy)) };
    },
    bump(dx) {
      if (state.kind !== "ground" && state.kind !== "landed") return 0;
      const from = x;
      x += dx;
      clampX();
      if (state.kind === "ground" && (state.mood === "walk" || state.mood === "run") && Math.sign(dx) === -state.dir) {
        state = { ...state, dir: (-state.dir) as Direction };
        facing = state.dir;
      }
      return x - from;
    },
    step(now, dt) {
      switch (state.kind) {
        case "ground": {
          y = groundY();
          if (now >= state.until) apply(pickNext(world.pet()), now);
          if (state.kind === "ground" && (state.mood === "walk" || state.mood === "run")) {
            x += state.dir * (state.mood === "walk" ? WALK_SPEED : RUN_SPEED) * world.scale() * dt;
            const { minX, maxX } = sideLimits();
            if (x < minX || x > maxX) {
              clampX();
              state = { ...state, dir: (-state.dir) as Direction };
              facing = state.dir;
            }
          } else {
            clampX(); // the bounds or the size may have changed under a standing pet
          }
          break;
        }
        case "fall": {
          state.vy += GRAVITY * dt;
          y += state.vy * dt;
          if (y >= groundY()) {
            y = groundY();
            clampX(); // dropped past a side edge: back inside
            state = { kind: "landed", until: now + LANDED_MS };
          }
          break;
        }
        case "landed":
          y = groundY();
          if (now >= state.until) state = { kind: "ground", mood: "idle", dir: facing, until: now + REST_AFTER_LANDING_MS };
          break;
        case "carried":
          break;
      }
    },
    animation() {
      switch (state.kind) {
        case "ground":
          return MOOD_ANIMATION[state.mood];
        case "carried":
        case "fall":
          return "gesture-negative";
        case "landed":
          return "gesture-positive";
      }
    },
    animationSpeed() {
      return state.kind === "carried" ? 1.5 : 1;
    },
  };
}

/**
 * Keeps pets that stand on the same ground from overlapping: any two whose
 * bodies overlap are pushed apart by half the overlap each (one that cannot
 * give way, at a side edge, leaves its half to the other), and a walker
 * pushed against its way turns around. Pets in the air or in hand pass
 * freely. Passes until nothing moves, because a push can make a new overlap
 * further along; a pile spreads out over a few of them.
 */
export function separate(lives: readonly Life[]): void {
  const standing = lives.filter((l) => l.state.kind === "ground" || l.state.kind === "landed");
  if (standing.length < 2) return;
  for (let pass = 0; pass < 32; pass++) {
    standing.sort((a, b) => a.x + a.size / 2 - (b.x + b.size / 2));
    let moved = 0;
    for (let i = 0; i + 1 < standing.length; i++) {
      const a = standing[i]!;
      const b = standing[i + 1]!;
      const overlap = a.x + a.size * (0.5 + BODY / 2) - (b.x + b.size * (0.5 - BODY / 2));
      if (overlap <= 0) continue;
      const wentA = a.bump(-overlap / 2);
      const wentB = b.bump(overlap + wentA);
      if (wentB < overlap + wentA) a.bump(-(overlap + wentA - wentB)); // b was at its edge too: a takes what b could not
      moved += Math.abs(wentA) + Math.abs(wentB);
    }
    if (moved < 1e-6) return;
  }
}
