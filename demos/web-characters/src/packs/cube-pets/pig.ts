import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-pig.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const pig = cubePetSpec("pig", url, { [PET_TEXTURE_FILE]: colormap });
