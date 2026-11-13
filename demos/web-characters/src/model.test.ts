import { describe, expect, test } from "bun:test";
import { clipFor, clipNames, drawMood, type ModelSpec } from "./model";

const model: ModelSpec = {
  name: "t",
  url: "f.glb",
  clips: { idle: "idle", landed: { name: "cheer", once: true } },
  moods: [
    { name: "idle", clip: "idle", weight: 1, seconds: [2, 4] },
    { name: "walk", clip: "walk", weight: 3, speed: 60, seconds: [3, 8] },
    { name: "spin", clip: "spin", seconds: [1, 2] },
  ],
};

describe("clips", () => {
  test("fall back: carried to idle, falling to carried to idle, landed to idle; once is kept", () => {
    expect(clipFor(model, "carried")).toEqual({ name: "idle", once: false });
    expect(clipFor(model, "falling")).toEqual({ name: "idle", once: false });
    expect(clipFor(model, "landed")).toEqual({ name: "cheer", once: true });
    expect(clipFor({ ...model, clips: { idle: "idle", carried: "held" } }, "falling")).toEqual({ name: "held", once: false });
    expect(clipNames(model).sort()).toEqual(["cheer", "idle", "spin", "walk"]);
  });
});

describe("drawMood", () => {
  test("draws by weight, within the mood's seconds", () => {
    const counts = { idle: 0, walk: 0, spin: 0 };
    for (let i = 0; i < 3000; i++) {
      const c = drawMood(model);
      counts[c.mood.name as keyof typeof counts]++;
      expect(c.seconds).toBeGreaterThanOrEqual(c.mood.seconds[0]);
      expect(c.seconds).toBeLessThanOrEqual(c.mood.seconds[1]);
      expect([-1, 1]).toContain(c.dir);
    }
    expect(counts.walk).toBeGreaterThan(counts.idle * 2);
    expect(counts.spin).toBeGreaterThan(0);
  });
  test("leaves out moods whose clip the file lacks, and keeps something when it lacks them all", () => {
    for (let i = 0; i < 200; i++) expect(drawMood(model, (c) => c !== "walk").mood.name).not.toBe("walk");
    expect(drawMood(model, () => false).mood).toBeDefined();
  });
});
