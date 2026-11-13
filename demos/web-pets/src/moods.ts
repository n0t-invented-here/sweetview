// What a pet does next on the ground, picked at random, weighted per animal.

import { isBird, type Pet } from "./pets";

/** What the pet is doing on the ground; each is one of the models' animations. */
export type Mood = "idle" | "walk" | "run" | "eat" | "dance";
export type Direction = -1 | 1;
export type Command = { mood: Mood; dir: Direction; seconds: number };

// Weighted draw. `eat` is pecking (see BIRDS in pets.ts): birds get it, nobody else does.
const BIRD_MOODS: Mood[] = ["idle", "idle", "walk", "walk", "walk", "run", "eat", "eat", "dance"];
const OTHER_MOODS: Mood[] = ["idle", "idle", "walk", "walk", "walk", "run", "dance"];
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

/** What this pet may do next, with how likely each is. */
export const moodsFor = (pet: Pet): readonly Mood[] => (isBird(pet) ? BIRD_MOODS : OTHER_MOODS);

export const nextCommand = (pet: Pet): Command => {
  const mood = pick(moodsFor(pet) as Mood[]);
  const seconds =
    mood === "walk" ? 3 + Math.random() * 5 : mood === "run" ? 1.5 + Math.random() * 2 : mood === "dance" ? 3 + Math.random() * 3 : 2 + Math.random() * 4;
  return { mood, dir: Math.random() < 0.5 ? -1 : 1, seconds };
};
