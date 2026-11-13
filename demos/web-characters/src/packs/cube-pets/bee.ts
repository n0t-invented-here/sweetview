import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-bee.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const bee = cubePetSpec("bee", url, { [PET_TEXTURE_FILE]: colormap });
