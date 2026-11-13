import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-koala.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const koala = cubePetSpec("koala", url, { [PET_TEXTURE_FILE]: colormap });
