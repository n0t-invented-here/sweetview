import { describe, expect, test } from "bun:test";
import { createLife, separate, type Life, type World } from "./life";
import type { Command } from "./moods";

const world = (over: Partial<World> = {}): World => ({
  bounds: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
  size: () => 192,
  scale: () => 1,
  bottom: () => 0,
  pet: () => "cat",
  ...over,
});
const idle: Command = { mood: "idle", dir: 1, seconds: 100 };
const walk = (dir: -1 | 1): Command => ({ mood: "walk", dir, seconds: 100 });

/** A life with a clock: `run` advances it `seconds` in 60 Hz steps. */
const start = (over: Partial<World> = {}) => {
  const life = createLife(world(over));
  let now = 0;
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      now += 1000 / 60;
      life.step(now, 1 / 60);
    }
  };
  return { life, run, now: () => now, step: (dt: number, others?: readonly Life[]) => life.step((now += dt * 1000), dt, others) };
};

describe("a spawned pet", () => {
  test("falls from where it was put and lands on the ground, with the positive gesture, then idles", () => {
    const { life, run } = start({ nextCommand: () => idle });
    life.spawn(400, 50);
    expect(life.state.kind).toBe("fall");
    expect(life.animation()).toBe("gesture-negative");
    expect(life.y).toBe(50);
    run(0.1);
    expect(life.y).toBeGreaterThan(50);
    expect(life.y).toBeLessThan(life.groundY());
    run(0.5);
    expect(life.y).toBe(life.groundY());
    expect(life.groundY()).toBe(600 - 192);
    expect(life.state.kind).toBe("landed");
    expect(life.animation()).toBe("gesture-positive");
    run(2);
    expect(life.state.kind).toBe("ground");
    expect(life.animation()).toBe("idle");
    expect(life.x).toBe(400);
  });
  test("stands `bottom` above the bounds' bottom edge", () => {
    const { life } = start({ bottom: () => 40 });
    expect(life.groundY()).toBe(600 - 192 - 40);
  });
  test("spawned past a side edge is pulled back inside, with the model's overhang", () => {
    const { life } = start();
    life.spawn(-500, 0);
    expect(life.x).toBe(-192 * 0.2);
    life.spawn(5000, 0);
    expect(life.x).toBe(1000 - 192 * 0.8);
  });
});

describe("on the ground", () => {
  test("walks the way the command says and turns around at the edge", () => {
    const { life, run } = start({ nextCommand: () => walk(1) });
    life.spawn(700, 600 - 192);
    run(3); // lands, gestures, rests, then the first command
    expect(life.state).toMatchObject({ kind: "ground", mood: "walk", dir: 1 });
    expect(life.facing).toBe(1);
    expect(life.animation()).toBe("walk");
    expect(life.x).toBeGreaterThan(700);
    run(4); // 55 px/s reaches the right limit, 846.4, turns, and walks back
    expect(life.state).toMatchObject({ kind: "ground", mood: "walk", dir: -1 });
    expect(life.facing).toBe(-1);
    expect(life.x).toBeLessThan(1000 - 192 * 0.8);
    expect(life.x).toBeGreaterThan(700);
  });
  test("speed follows the scale", () => {
    const fast = start({ nextCommand: () => walk(-1), scale: () => 2, size: () => 384 });
    const slow = start({ nextCommand: () => walk(-1) });
    const walked: number[] = [];
    for (const { life, run, step } of [fast, slow]) {
      life.spawn(600, 600 - 384);
      run(3); // on the ground and walking
      expect(life.state).toMatchObject({ mood: "walk", dir: -1 });
      const before = life.x;
      step(1); // one second of it
      walked.push(before - life.x);
    }
    expect(walked[0]).toBeCloseTo(2 * walked[1]!, 5);
  });
  test("asks for the next command when the current one ends", () => {
    const asked: number[] = [];
    const { life, run } = start({ nextCommand: () => (asked.push(1), { mood: "dance", dir: 1, seconds: 1 }) });
    life.spawn(100, 600 - 192);
    run(7);
    expect(asked.length).toBeGreaterThanOrEqual(4);
    expect(life.animation()).toBe("dance");
  });
});

describe("picked up", () => {
  test("goes where it is carried, plays the negative gesture faster, and falls when dropped, clamped to a throw", () => {
    const { life, run, step } = start({ nextCommand: () => idle });
    life.spawn(100, 600 - 192);
    run(3);
    life.pickUp();
    expect(life.animation()).toBe("gesture-negative");
    expect(life.animationSpeed()).toBe(1.5);
    life.carryTo(500, 100);
    step(1 / 60);
    expect(life.x).toBe(500);
    expect(life.y).toBe(100);
    life.drop(-99999);
    expect(life.state).toEqual({ kind: "fall", vy: -800 });
    step(1 / 60);
    expect(life.y).toBeLessThan(100); // thrown up first
    run(3);
    expect(life.y).toBe(life.groundY());
  });
  test("carryTo and drop do nothing when not carried", () => {
    const { life } = start();
    life.spawn(100, 100);
    life.carryTo(5, 5);
    expect(life.x).toBe(100);
    life.drop(10);
    expect(life.state).toEqual({ kind: "fall", vy: 0 });
  });
});

describe("the world changes under a standing pet", () => {
  test("a narrower bounds pulls it back inside; a lower ground keeps its feet on it", () => {
    let width = 1000;
    let height = 600;
    const { life, run, step } = start({ nextCommand: () => idle, bounds: () => ({ x: 0, y: 0, width, height }) });
    life.spawn(900, 600 - 192);
    run(3);
    width = 500;
    height = 400;
    step(1 / 60);
    expect(life.x).toBe(500 - 192 * 0.8);
    expect(life.y).toBe(400 - 192);
  });
});

describe("pets on the same ground", () => {
  const standing = (x: number, over: Partial<World> = {}) => {
    const s = start({ nextCommand: () => idle, ...over });
    s.life.spawn(x, 600 - 192);
    s.run(3);
    return s;
  };
  test("two that overlap are pushed apart by half the overlap each; apart ones stay put", () => {
    const a = standing(300);
    const b = standing(340); // bodies (60% of 192 = 115.2 wide, centred) overlap by 75.2
    separate([a.life, b.life]);
    expect(a.life.x).toBeCloseTo(300 - 37.6, 5);
    expect(b.life.x).toBeCloseTo(340 + 37.6, 5);
    separate([a.life, b.life]);
    expect(a.life.x).toBeCloseTo(300 - 37.6, 5);
  });
  test("one against the side edge cannot give way, so the other takes the whole push", () => {
    const a = standing(-500); // clamped to the left limit
    const b = standing(a.life.x + 10);
    separate([a.life, b.life]);
    expect(a.life.x).toBe(-192 * 0.2);
    expect(b.life.x + 192 * 0.2).toBeGreaterThanOrEqual(a.life.x + 192 * 0.8 - 1e-6);
  });
  test("a walker bumped against its way turns around; a falling or carried pet passes freely", () => {
    const walker = standing(300, { nextCommand: () => walk(1) });
    const wall = standing(380);
    expect(walker.life.state).toMatchObject({ mood: "walk", dir: 1 });
    separate([walker.life, wall.life]);
    expect(walker.life.state).toMatchObject({ mood: "walk", dir: -1 });
    expect(walker.life.facing).toBe(-1);
    const flying = start();
    flying.life.spawn(wall.life.x, 0);
    const before = wall.life.x;
    separate([wall.life, flying.life]);
    expect(wall.life.x).toBe(before);
    expect(flying.life.x).toBe(before);
    wall.life.pickUp();
    const other = standing(wall.life.x);
    separate([wall.life, other.life]);
    expect(other.life.x).toBe(wall.life.x);
  });
  test("three in a pile spread out without overlap", () => {
    const lives = [standing(400), standing(400), standing(400)].map((s) => s.life);
    separate(lives);
    const xs = lives.map((l) => l.x).sort((p, q) => p - q);
    expect(xs[1]! - xs[0]!).toBeCloseTo(192 * 0.6, 5);
    expect(xs[2]! - xs[1]!).toBeCloseTo(192 * 0.6, 5);
  });
});

describe("standing on each other", () => {
  const onGround = (x: number, over: Partial<World> = {}) => {
    const s = start({ nextCommand: () => idle, ...over });
    s.life.spawn(x, 600 - 192);
    s.run(3);
    return s;
  };
  /** Step both lives `seconds` on one clock, like the herd does. */
  const together = (all: ReturnType<typeof start>[], seconds: number) => {
    const lives = all.map((s) => s.life);
    for (let i = 0; i < seconds * 60; i++) for (const s of all) s.step(1 / 60, lives);
    separate(lives);
  };
  test("a pet dropped over another lands on its head and stands there", () => {
    const base = onGround(400);
    const top = start({ nextCommand: () => idle });
    top.life.spawn(400, 100);
    together([base, top], 3);
    expect(top.life.standingOn).toBe(base.life);
    expect(top.life.y).toBeCloseTo(base.life.y + 192 * 0.25 - 192, 5);
    expect(top.life.state.kind).toBe("ground");
    expect(base.life.x).toBe(400); // not pushed: different levels
    expect(top.life.x).toBe(400);
  });
  test("a pet beside another at the same level never climbs it", () => {
    const a = onGround(400);
    const b = onGround(420);
    together([a, b], 1);
    expect(a.life.standingOn).toBeUndefined();
    expect(b.life.standingOn).toBeUndefined();
    expect(b.life.x - a.life.x).toBeCloseTo(192 * 0.6, 5);
  });
  test("rides along when the one below walks, and falls when it is picked up", () => {
    const base = onGround(400, { nextCommand: () => walk(1) });
    const top = start({ nextCommand: () => idle });
    top.life.spawn(base.life.x + 40, 100); // the base is already walking right; land just ahead of its centre
    together([base, top], 3);
    expect(top.life.standingOn).toBe(base.life);
    const before = { base: base.life.x, top: top.life.x };
    together([base, top], 1);
    expect(base.life.x).toBeGreaterThan(before.base);
    expect(top.life.x - before.top).toBeCloseTo(base.life.x - before.base, 0);
    base.life.pickUp();
    together([base, top], 0.1);
    expect(top.life.state.kind).toBe("fall");
    together([base, top], 2);
    expect(top.life.y).toBe(top.life.groundY());
    expect(top.life.standingOn).toBeUndefined();
  });
  test("walks off the edge of a head and drops to the ground", () => {
    const base = onGround(400);
    const top = start({ nextCommand: () => walk(1) });
    top.life.spawn(400, 100);
    together([base, top], 3);
    expect(top.life.standingOn).toBe(base.life);
    together([base, top], 4);
    expect(top.life.standingOn).toBeUndefined();
    expect(top.life.y).toBe(top.life.groundY());
    expect(top.life.x).toBeGreaterThan(400 + 192 * 0.3);
  });
  test("a tower of three", () => {
    const a = onGround(500);
    const b = start({ nextCommand: () => idle });
    b.life.spawn(500, 100);
    together([a, b], 3);
    const c = start({ nextCommand: () => idle });
    c.life.spawn(500, -100);
    together([a, b, c], 3);
    expect(b.life.standingOn).toBe(a.life);
    expect(c.life.standingOn).toBe(b.life);
    expect(c.life.y).toBeCloseTo(a.life.y - 2 * 192 * 0.75, 5);
  });
});
