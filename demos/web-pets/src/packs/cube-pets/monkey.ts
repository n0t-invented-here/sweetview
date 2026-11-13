import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-monkey.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const monkey = cubePetSpec("monkey", url, { [PET_TEXTURE_FILE]: colormap });
