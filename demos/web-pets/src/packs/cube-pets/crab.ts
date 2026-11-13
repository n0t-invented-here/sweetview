import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-crab.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const crab = cubePetSpec("crab", url, { [PET_TEXTURE_FILE]: colormap });
