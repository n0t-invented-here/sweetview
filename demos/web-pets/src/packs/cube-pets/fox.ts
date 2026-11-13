import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-fox.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const fox = cubePetSpec("fox", url, { [PET_TEXTURE_FILE]: colormap });
