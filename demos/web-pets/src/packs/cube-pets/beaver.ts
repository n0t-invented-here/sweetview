import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-beaver.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const beaver = cubePetSpec("beaver", url, { [PET_TEXTURE_FILE]: colormap });
