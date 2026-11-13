import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-dog.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const dog = cubePetSpec("dog", url, { [PET_TEXTURE_FILE]: colormap });
