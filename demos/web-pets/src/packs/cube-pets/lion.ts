import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-lion.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const lion = cubePetSpec("lion", url, { [PET_TEXTURE_FILE]: colormap });
