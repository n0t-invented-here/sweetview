import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-polar.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const polar = cubePetSpec("polar", url, { [PET_TEXTURE_FILE]: colormap });
