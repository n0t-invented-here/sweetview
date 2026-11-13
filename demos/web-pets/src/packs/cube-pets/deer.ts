import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-deer.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const deer = cubePetSpec("deer", url, { [PET_TEXTURE_FILE]: colormap });
