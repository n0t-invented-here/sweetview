// Kenney's Cube Pets (CC0): 24 animals, one glTF each, all sharing one
// texture and the same eight clips. This module is the pack as data with no
// files in it: the names, the labels, the file names, which are birds, and
// the moods; index.ts adds the files. The desktop pet imports this one.

import { drawMood, type Direction, type MoodSpec, type PetModel } from "../../model";

export const PETS = [
  "beaver",
  "bee",
  "bunny",
  "cat",
  "caterpillar",
  "chick",
  "cow",
  "crab",
  "deer",
  "dog",
  "elephant",
  "fish",
  "fox",
  "giraffe",
  "hog",
  "koala",
  "lion",
  "monkey",
  "panda",
  "parrot",
  "penguin",
  "pig",
  "polar",
  "tiger",
] as const;

export type Pet = (typeof PETS)[number];

/** Every model has these, by name, in its animation groups. */
export type PetAnimation = "static" | "idle" | "walk" | "run" | "eat" | "dance" | "gesture-positive" | "gesture-negative";

/**
 * The birds. The shared `eat` animation is a dip of the head to the ground,
 * which reads as pecking: right on these, wrong on everything else, so only
 * the birds ever play it.
 */
export const BIRDS: ReadonlySet<Pet> = new Set<Pet>(["chick", "parrot", "penguin"]);
export const isBird = (pet: Pet): boolean => BIRDS.has(pet);

export const petLabel = (pet: Pet): string => (pet === "polar" ? "Polar bear" : pet[0]!.toUpperCase() + pet.slice(1));
export const isPet = (name: unknown): name is Pet => typeof name === "string" && (PETS as readonly string[]).includes(name);
export const randomPet = (): Pet => PETS[Math.floor(Math.random() * PETS.length)]!;

/** A pet's model file, relative to the pack folder (assets/kenney-cube-pets). */
export const petModelFile = (pet: Pet): string => `animal-${pet}.glb`;
/** The one texture every model references, relative to the pack folder; the models reference it by this path. */
export const PET_TEXTURE_FILE = "Textures/colormap.png";
/** Kenney's own 64x64 render of a pet, relative to the pack folder. */
export const petPreviewFile = (pet: Pet): string => `Previews/animal-${pet}.png`;

/** What the pets do on the ground, as the moods' names. `eat` is pecking: the birds get it, nobody else does. */
export type Mood = "idle" | "walk" | "run" | "eat" | "dance";

export const cubePetMoods = (pet: Pet): MoodSpec[] => [
  { name: "idle", clip: "idle", weight: 2, seconds: [2, 6] },
  { name: "walk", clip: "walk", weight: 3, speed: 55, seconds: [3, 8] }, // 55 px/s at scale 1, matched to the walk cycle
  { name: "run", clip: "run", weight: 1, speed: 150, seconds: [1.5, 3.5] },
  { name: "dance", clip: "dance", weight: 1, seconds: [3, 6] },
  ...(isBird(pet) ? [{ name: "eat", clip: "eat", weight: 2, seconds: [2, 6] as [number, number] }] : []),
];

/** The spec for a pet whose file (and the shared texture) is at these URLs. */
export const cubePetSpec = (pet: Pet, url: string, textures: Record<string, string>): PetModel => ({
  name: petLabel(pet),
  url,
  textures,
  clips: { idle: "idle", carried: "gesture-negative", falling: "gesture-negative", landed: "gesture-positive" },
  moods: cubePetMoods(pet),
});

// The desktop pet's contract: moods by name, from the same moods.
export type Command = { mood: Mood; dir: Direction; seconds: number };
/** What this pet may do next, by name, with how likely each is (a name repeats by its weight). */
export const moodsFor = (pet: Pet): readonly Mood[] => cubePetMoods(pet).flatMap((m) => Array<Mood>(m.weight ?? 1).fill(m.name as Mood));
export const nextCommand = (pet: Pet): Command => {
  const { mood, dir, seconds } = drawMood({ name: pet, url: "", clips: { idle: "idle" }, moods: cubePetMoods(pet) });
  return { mood: mood.name as Mood, dir, seconds };
};
