// The pets come from @n1h/web-pets: the list, the moods, the model files.
// This is where this app serves them: the page fetches the models by
// relative URL from its own origin, under pets/ (the asset table in app.ts).

import { PET_TEXTURE_FILE, petModelFile, type Pet } from "@n1h/web-pets";

export { PETS, petLabel, randomPet, type Pet, type PetAnimation } from "@n1h/web-pets";

export const petModelPath = (pet: Pet): string => `pets/${petModelFile(pet)}`;
export const PET_TEXTURE_PATH = `pets/${PET_TEXTURE_FILE}`;
