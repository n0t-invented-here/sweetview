import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-giraffe.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const giraffe = cubePetSpec("giraffe", url, { [PET_TEXTURE_FILE]: colormap });
