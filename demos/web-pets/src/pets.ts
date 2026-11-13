// The pets: Kenney's Cube Pets (CC0), one glTF each, all sharing one texture
// and the same eight animations. The files are in this package's assets/
// folder; a page serves that folder and tells createPet where (assetsUrl).

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

/** A pet's model file, relative to the assets folder. The texture is referenced from inside the file, relative to it. */
export const petModelFile = (pet: Pet): string => `animal-${pet}.glb`;
/** The one texture every model references, relative to the assets folder. */
export const PET_TEXTURE_FILE = "Textures/colormap.png";
/** Kenney's own 64x64 render of a pet, relative to the assets folder. */
export const petPreviewFile = (pet: Pet): string => `Previews/animal-${pet}.png`;
