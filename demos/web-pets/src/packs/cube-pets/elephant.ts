import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-elephant.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const elephant = cubePetSpec("elephant", url, { [PET_TEXTURE_FILE]: colormap });
