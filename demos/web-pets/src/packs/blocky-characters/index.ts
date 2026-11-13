// Kenney's Blocky Characters, with their files: all four, for a page that
// wants the whole pack. One character: `@n1h/web-pets/packs/blocky-characters/a`.

import type { PetModel } from "../../model";
import { characterA } from "./a";
import { characterB } from "./b";
import { characterC } from "./c";
import { characterD } from "./d";

export { characterA, characterB, characterC, characterD };

export const BLOCKY_CHARACTERS: readonly PetModel[] = [characterA, characterB, characterC, characterD];
