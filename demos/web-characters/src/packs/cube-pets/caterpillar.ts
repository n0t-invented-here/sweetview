import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-caterpillar.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const caterpillar = cubePetSpec("caterpillar", url, { [PET_TEXTURE_FILE]: colormap });
