import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-panda.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const panda = cubePetSpec("panda", url, { [PET_TEXTURE_FILE]: colormap });
