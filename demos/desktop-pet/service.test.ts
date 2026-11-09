import { describe, expect, test } from "bun:test";
import { BIRDS, PETS } from "./pets";
import { moodsFor, nextCommand } from "./service";

describe("moods per pet", () => {
  test("only the birds ever eat (it is a pecking animation)", () => {
    for (const pet of PETS) {
      const eats = moodsFor(pet).includes("eat");
      expect(eats, pet).toBe(BIRDS.has(pet));
    }
  });
  test("a non-bird never draws eat, a bird does", () => {
    const draws = (pet: (typeof PETS)[number]) => new Set(Array.from({ length: 500 }, () => nextCommand(pet).mood));
    expect(draws("cat").has("eat")).toBe(false);
    expect(draws("fish").has("eat")).toBe(false);
    expect(draws("chick").has("eat")).toBe(true);
  });
  test("every command is a mood the models can play, with a direction and a length", () => {
    for (const pet of ["cow", "parrot"] as const) {
      const cmd = nextCommand(pet);
      expect(["idle", "walk", "run", "eat", "dance"]).toContain(cmd.mood);
      expect([-1, 1]).toContain(cmd.dir);
      expect(cmd.seconds).toBeGreaterThan(0);
    }
  });
});
