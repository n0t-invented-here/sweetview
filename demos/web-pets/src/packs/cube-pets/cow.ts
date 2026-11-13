import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-cow.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const cow = cubePetSpec("cow", url, { [PET_TEXTURE_FILE]: colormap });
