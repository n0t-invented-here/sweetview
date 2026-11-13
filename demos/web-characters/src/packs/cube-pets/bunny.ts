import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-bunny.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const bunny = cubePetSpec("bunny", url, { [PET_TEXTURE_FILE]: colormap });
