// The character's little life, with no screen in it: a square box that falls,
// lands, walks and runs along the bottom edge of its bounds, turns at the
// sides, and can be picked up and thrown. With other lives on the same
// ground it lands on their heads, rides along, walks off, and bumps into the
// ones at its level. Units are whatever the world's are (CSS pixels on a
// page); the page draws the model in the box.

import { FEET } from "./framing";
import { clipFor, drawMood, type ClipRef, type Direction, type MoodCommand, type MoodSpec, type ModelSpec } from "./model";

export type Box = { x: number; y: number; width: number; height: number };

export type LifeState =
  | { kind: "ground"; mood: MoodSpec; dir: Direction; until: number }
  | { kind: "fall"; vy: number }
  | { kind: "carried" }
  | { kind: "landed"; until: number };

/** What the life reads each step; every value may change between steps (a resize, a settings change). */
export type World = {
  /** Where the character may be. The ground is the bottom edge. */
  bounds: () => Box;
  /** Edge of the character's square box. */
  size: () => number;
  /** The model's scale: speeds follow it, so the stride matches the walk cycle at every size. */
  scale: () => number;
  /** Lift above the bounds' bottom edge. */
  bottom: () => number;
  /** Which model this is: its moods, its clips. */
  model: () => ModelSpec;
  /** Which clips the loaded file has; a mood whose clip it lacks is never drawn. All, when not given. */
  has?: (clip: string) => boolean;
  /** How long a clip takes; a `landed` clip played once sets how long the landing lasts. */
  clipSeconds?: (clip: string) => number | undefined;
  /** How much of the box the model fills side to side, how far down its head is, and how far down its feet are; the defaults when not given. */
  body?: () => number;
  head?: () => number;
  feet?: () => number;
  /** What to do next on the ground; a weighted draw from the model's moods by default. */
  nextCommand?: (model: ModelSpec) => MoodCommand;
};

export type Life = {
  /** The box's top-left. */
  readonly x: number;
  readonly y: number;
  readonly facing: Direction;
  readonly state: LifeState;
  /** The box's edge, as the world says. */
  readonly size: number;
  /** How much of the box the body fills side to side, how far down the head is, and how far down the feet are, as fractions of the box. */
  readonly body: number;
  readonly head: number;
  readonly feet: number;
  /** How far the last step moved it sideways (walking, riding); what a character on its head follows. */
  readonly dx: number;
  /** The character it stands on, when not on the ground. */
  readonly standingOn: Life | undefined;
  /** Where the box's top is when the character stands on the ground. */
  groundY(): number;
  /** Put the box's top-left here and let the character fall. */
  spawn(x: number, y: number): void;
  pickUp(): void;
  /** While carried: the box's new top-left. */
  carryTo(x: number, y: number): void;
  /** Turn to face this way; walking and running set it themselves. */
  face(dir: Direction): void;
  /** Let go, moving at this vertical speed (units per second, positive is down); clamped to a throw. */
  drop(vy: number): void;
  /** Pushed sideways by another character, on the ground only; a walker pushed against its way turns around. The reply is how far it went (less than asked at a side edge). */
  bump(dx: number): number;
  /** Advance by `dt` seconds at time `now` (milliseconds, as `performance.now()`), among the other lives on this ground (heads to land on, backs to ride). */
  step(now: number, dt: number, others?: readonly Life[]): void;
  /** The clip for the current state, and its speed. */
  animation(): ClipRef;
  animationSpeed(): number;
};

export const GRAVITY = 2400;
export const MAX_THROW = 800;
const LANDED_MS = 1200; // the landing clip, when it loops
const REST_AFTER_LANDING_MS = 800;
/** How much of its box the character may hang past a side edge: the model does not fill the square. */
const OVERHANG = 0.2;
/** How much of its box a character's body fills side to side, until the model is measured: for bumping into other characters and standing on them. */
export const BODY = 0.6;
/** How far down its box the top of a character's head is, until the model is measured: where another character's feet rest. */
export const HEAD = 0.25;
export { FEET };
const isStanding = (l: Life) => l.state.kind === "ground" || l.state.kind === "landed";

export function createLife(world: World): Life {
  const pickNext = world.nextCommand ?? ((model: ModelSpec) => drawMood(model, world.has));
  const moving = (mood: MoodSpec) => (mood.speed ?? 0) > 0;
  /** Standing still after a landing, before the first mood: the idle clip. */
  const rest = (): MoodSpec => ({ name: "idle", clip: clipFor(world.model(), "idle").name, seconds: [0, 0] });
  /** How long a landing lasts: the landed clip's length when it plays once, else a fixed moment. */
  const landedMs = () => {
    const clip = clipFor(world.model(), "landed");
    const seconds = clip.once ? world.clipSeconds?.(clip.name) : undefined;
    return seconds ? seconds * 1000 : LANDED_MS;
  };
  let x = 0;
  let y = 0;
  let dx = 0;
  let facing: Direction = 1;
  let state: LifeState = { kind: "fall", vy: 0 };
  let on: Life | undefined;

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
  const apply = (cmd: MoodCommand, now: number) => {
    state = { kind: "ground", mood: cmd.mood, dir: cmd.dir, until: now + cmd.seconds * 1000 };
    if (moving(cmd.mood)) facing = cmd.dir;
  };
  /**
   * Where this character's box top rests: the ground, or the head of the highest
   * standing character whose body is under this character's centre and whose head was
   * not above the feet (at `feetBefore`) when the step began, so a fall
   * never passes through a head and a character beside another never climbs it.
   */
  const floorAmong = (others: readonly Life[], feetBefore: number): { y: number; on: Life | undefined } => {
    const size = world.size();
    const cx = x + size / 2;
    const feetOffset = size * self.feet; // the feet are drawn this far down the box
    let best: { y: number; on: Life | undefined } = { y: groundY(), on: undefined };
    for (const o of others) {
      if (o === self || !isStanding(o)) continue;
      if (cx < o.x + o.size * (0.5 - o.body / 2) || cx > o.x + o.size * (0.5 + o.body / 2)) continue;
      const head = o.y + o.size * o.head;
      if (head < feetBefore - 1) continue;
      if (head - feetOffset < best.y) best = { y: head - feetOffset, on: o };
    }
    return best;
  };
  /** Standing: follow the floor; when it is gone (the support walked away or was picked up), fall. The reply is whether the character still stands. */
  const stand = (others: readonly Life[], feetBefore: number): boolean => {
    const floor = floorAmong(others, feetBefore);
    if (floor.y > y + 1) {
      state = { kind: "fall", vy: 0 };
      on = undefined;
      return false;
    }
    y = floor.y;
    on = floor.on;
    if (on) x += on.dx; // ride
    return true;
  };

  const self: Life = {
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    get dx() {
      return dx;
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
    get body() {
      return world.body?.() ?? BODY;
    },
    get head() {
      return world.head?.() ?? HEAD;
    },
    get feet() {
      return world.feet?.() ?? FEET;
    },
    get standingOn() {
      return on;
    },
    groundY,
    spawn(nx, ny) {
      x = nx;
      y = ny;
      clampX();
      state = { kind: "fall", vy: 0 };
      on = undefined;
    },
    pickUp() {
      state = { kind: "carried" };
      on = undefined;
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
      if (!isStanding(self)) return 0;
      const from = x;
      x += dx;
      clampX();
      if (state.kind === "ground" && moving(state.mood) && Math.sign(dx) === -state.dir) {
        state = { ...state, dir: (-state.dir) as Direction };
        facing = state.dir;
      }
      return x - from;
    },
    step(now, dt, others = []) {
      const xBefore = x;
      const feetBefore = y + world.size() * self.feet;
      switch (state.kind) {
        case "ground": {
          if (!stand(others, feetBefore)) break;
          if (now >= state.until) apply(pickNext(world.model()), now);
          if (state.kind === "ground" && moving(state.mood)) {
            x += state.dir * state.mood.speed! * world.scale() * dt;
            const { minX, maxX } = sideLimits();
            if (x < minX || x > maxX) {
              clampX();
              state = { ...state, dir: (-state.dir) as Direction };
              facing = state.dir;
            }
          } else {
            clampX(); // the bounds or the size may have changed under a standing character
          }
          break;
        }
        case "fall": {
          state.vy += GRAVITY * dt;
          y += state.vy * dt;
          const floor = floorAmong(others, feetBefore);
          if (y >= floor.y) {
            y = floor.y;
            on = floor.on;
            clampX(); // dropped past a side edge: back inside
            state = { kind: "landed", until: now + landedMs() };
          }
          break;
        }
        case "landed":
          if (!stand(others, feetBefore)) break;
          if (now >= state.until) state = { kind: "ground", mood: rest(), dir: facing, until: now + REST_AFTER_LANDING_MS };
          break;
        case "carried":
          break;
      }
      dx = x - xBefore;
    },
    animation() {
      switch (state.kind) {
        case "ground":
          return { name: state.mood.clip, once: false };
        case "carried":
          return clipFor(world.model(), "carried");
        case "fall":
          return clipFor(world.model(), "falling");
        case "landed":
          return clipFor(world.model(), "landed");
      }
    },
    animationSpeed() {
      return state.kind === "carried" ? 1.5 : 1;
    },
  };
  return self;
}

/**
 * Keeps characters standing at the same level (on the ground, or on the same head)
 * from overlapping: any two whose bodies overlap are pushed apart by half
 * the overlap each (one that cannot give way, at a side edge, leaves its
 * half to the other), and a walker pushed against its way turns around. A
 * character on another's head is not pushed off it; characters in the air or in hand
 * pass freely. Passes until nothing moves, because a push can make a new
 * overlap further along; a pile spreads out over a few of them.
 */
export function separate(lives: readonly Life[]): void {
  const standing = lives.filter(isStanding);
  if (standing.length < 2) return;
  const sameLevel = (a: Life, b: Life) => Math.abs(a.y + a.size * a.feet - (b.y + b.size * b.feet)) < 0.5 * Math.min(a.size, b.size);
  for (let pass = 0; pass < 32; pass++) {
    standing.sort((a, b) => a.x + a.size / 2 - (b.x + b.size / 2));
    let moved = 0;
    for (let i = 0; i + 1 < standing.length; i++) {
      for (let j = i + 1; j < standing.length; j++) {
        const a = standing[i]!;
        const b = standing[j]!;
        if (!sameLevel(a, b)) continue;
        const overlap = a.x + a.size * (0.5 + a.body / 2) - (b.x + b.size * (0.5 - b.body / 2));
        if (overlap <= 0) continue;
        const wentA = a.bump(-overlap / 2);
        const wentB = b.bump(overlap + wentA);
        if (wentB < overlap + wentA) a.bump(-(overlap + wentA - wentB)); // b was at its edge too: a takes what b could not
        moved += Math.abs(wentA) + Math.abs(wentB);
      }
    }
    if (moved < 1e-6) return;
  }
}
