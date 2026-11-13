import colormap from "../../../assets/kenney-mini-characters/Textures/colormap.png";
import url from "../../../assets/kenney-mini-characters/character-female-c.glb";
import { TEXTURE_FILE, miniCharacterSpec } from "./spec";

export const femaleC = miniCharacterSpec("Mini female-c", url, { [TEXTURE_FILE]: colormap });
