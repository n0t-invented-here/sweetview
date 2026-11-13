import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-parrot.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const parrot = cubePetSpec("parrot", url, { [PET_TEXTURE_FILE]: colormap });
