import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-cat.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const cat = cubePetSpec("cat", url, { [PET_TEXTURE_FILE]: colormap });
