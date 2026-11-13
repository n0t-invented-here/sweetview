import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-chick.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const chick = cubePetSpec("chick", url, { [PET_TEXTURE_FILE]: colormap });
