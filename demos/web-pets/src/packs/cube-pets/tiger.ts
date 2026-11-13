import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-tiger.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const tiger = cubePetSpec("tiger", url, { [PET_TEXTURE_FILE]: colormap });
