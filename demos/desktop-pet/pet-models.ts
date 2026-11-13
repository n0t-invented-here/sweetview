// Where each model's bytes come from (the @n1h/web-pets assets), as paths `bun build --compile` embeds.
// One static import per file: that is what embedding needs. The list of pets
// itself lives in pets.ts.

import type { Pet } from "./pets";

import colormap from "@n1h/web-pets/assets/kenney-cube-pets/Textures/colormap.png" with { type: "file" };
import beaver from "@n1h/web-pets/assets/kenney-cube-pets/animal-beaver.glb" with { type: "file" };
import bee from "@n1h/web-pets/assets/kenney-cube-pets/animal-bee.glb" with { type: "file" };
import bunny from "@n1h/web-pets/assets/kenney-cube-pets/animal-bunny.glb" with { type: "file" };
import cat from "@n1h/web-pets/assets/kenney-cube-pets/animal-cat.glb" with { type: "file" };
import caterpillar from "@n1h/web-pets/assets/kenney-cube-pets/animal-caterpillar.glb" with { type: "file" };
import chick from "@n1h/web-pets/assets/kenney-cube-pets/animal-chick.glb" with { type: "file" };
import cow from "@n1h/web-pets/assets/kenney-cube-pets/animal-cow.glb" with { type: "file" };
import crab from "@n1h/web-pets/assets/kenney-cube-pets/animal-crab.glb" with { type: "file" };
import deer from "@n1h/web-pets/assets/kenney-cube-pets/animal-deer.glb" with { type: "file" };
import dog from "@n1h/web-pets/assets/kenney-cube-pets/animal-dog.glb" with { type: "file" };
import elephant from "@n1h/web-pets/assets/kenney-cube-pets/animal-elephant.glb" with { type: "file" };
import fish from "@n1h/web-pets/assets/kenney-cube-pets/animal-fish.glb" with { type: "file" };
import fox from "@n1h/web-pets/assets/kenney-cube-pets/animal-fox.glb" with { type: "file" };
import giraffe from "@n1h/web-pets/assets/kenney-cube-pets/animal-giraffe.glb" with { type: "file" };
import hog from "@n1h/web-pets/assets/kenney-cube-pets/animal-hog.glb" with { type: "file" };
import koala from "@n1h/web-pets/assets/kenney-cube-pets/animal-koala.glb" with { type: "file" };
import lion from "@n1h/web-pets/assets/kenney-cube-pets/animal-lion.glb" with { type: "file" };
import monkey from "@n1h/web-pets/assets/kenney-cube-pets/animal-monkey.glb" with { type: "file" };
import panda from "@n1h/web-pets/assets/kenney-cube-pets/animal-panda.glb" with { type: "file" };
import parrot from "@n1h/web-pets/assets/kenney-cube-pets/animal-parrot.glb" with { type: "file" };
import penguin from "@n1h/web-pets/assets/kenney-cube-pets/animal-penguin.glb" with { type: "file" };
import pig from "@n1h/web-pets/assets/kenney-cube-pets/animal-pig.glb" with { type: "file" };
import polar from "@n1h/web-pets/assets/kenney-cube-pets/animal-polar.glb" with { type: "file" };
import tiger from "@n1h/web-pets/assets/kenney-cube-pets/animal-tiger.glb" with { type: "file" };

export const PET_MODEL_FILES: Record<Pet, string> = {
  beaver,
  bee,
  bunny,
  cat,
  caterpillar,
  chick,
  cow,
  crab,
  deer,
  dog,
  elephant,
  fish,
  fox,
  giraffe,
  hog,
  koala,
  lion,
  monkey,
  panda,
  parrot,
  penguin,
  pig,
  polar,
  tiger,
};

/** The one texture every model references. */
export const PET_TEXTURE_FILE: string = colormap;
