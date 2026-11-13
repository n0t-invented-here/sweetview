// Kenney's Blocky Characters, with their files: all four, for a page that
// wants the whole pack. One character: `@n1h/web-characters/packs/blocky-characters/a`.

import type { ModelSpec } from "../../model";
import { characterA } from "./a";
import { characterB } from "./b";
import { characterC } from "./c";
import { characterD } from "./d";

export { characterA, characterB, characterC, characterD };

export const BLOCKY_CHARACTERS: readonly ModelSpec[] = [characterA, characterB, characterC, characterD];
