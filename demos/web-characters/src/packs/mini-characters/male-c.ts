import colormap from "../../../assets/kenney-mini-characters/Textures/colormap.png";
import url from "../../../assets/kenney-mini-characters/character-male-c.glb";
import { TEXTURE_FILE, miniCharacterSpec } from "./spec";

export const maleC = miniCharacterSpec("Mini male-c", url, { [TEXTURE_FILE]: colormap });
