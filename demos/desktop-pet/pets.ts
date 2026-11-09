// The pets: Kenney's Cube Pets (CC0), one glTF each, all sharing one texture
// and the same eight animations. Shared by the UI thread (tray menu, asset
// table) and the page (loading, animating).

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

/** Menu label. */
export const petLabel = (pet: Pet): string => (pet === "polar" ? "Polar bear" : pet[0]!.toUpperCase() + pet.slice(1));

/** Asset path of a pet's model; its texture is referenced from inside the file, relative to it. */
export const petModelPath = (pet: Pet): string => `pets/animal-${pet}.glb`;
export const PET_TEXTURE_PATH = "pets/Textures/colormap.png";

export const randomPet = (): Pet => PETS[Math.floor(Math.random() * PETS.length)]!;
