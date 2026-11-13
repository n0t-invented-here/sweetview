import colormap from "../../../assets/kenney-mini-characters/Textures/colormap.png";
import url from "../../../assets/kenney-mini-characters/character-female-b.glb";
import { TEXTURE_FILE, miniCharacterSpec } from "./spec";

export const femaleB = miniCharacterSpec("Mini female-b", url, { [TEXTURE_FILE]: colormap });
