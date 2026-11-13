import colormap from "../../../assets/kenney-mini-characters/Textures/colormap.png";
import url from "../../../assets/kenney-mini-characters/character-male-a.glb";
import { TEXTURE_FILE, miniCharacterSpec } from "./spec";

export const maleA = miniCharacterSpec("Mini male-a", url, { [TEXTURE_FILE]: colormap });
