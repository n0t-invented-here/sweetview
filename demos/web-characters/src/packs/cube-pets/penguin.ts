import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-penguin.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const penguin = cubePetSpec("penguin", url, { [PET_TEXTURE_FILE]: colormap });
