// Where each pet's preview picture comes from (Kenney's own 64x64 renders, in
// the pack's Previews/ folder), as paths `bun build --compile` embeds. One
// static import per file, like pet-models.ts. They are the app's icons: the
// tray, the Pet menu, the settings window and the Dock show the current pet.

import type { Pet } from "./pets";

import beaver from "./assets/kenney-cube-pets/Previews/animal-beaver.png" with { type: "file" };
import bee from "./assets/kenney-cube-pets/Previews/animal-bee.png" with { type: "file" };
import bunny from "./assets/kenney-cube-pets/Previews/animal-bunny.png" with { type: "file" };
import cat from "./assets/kenney-cube-pets/Previews/animal-cat.png" with { type: "file" };
import caterpillar from "./assets/kenney-cube-pets/Previews/animal-caterpillar.png" with { type: "file" };
import chick from "./assets/kenney-cube-pets/Previews/animal-chick.png" with { type: "file" };
import cow from "./assets/kenney-cube-pets/Previews/animal-cow.png" with { type: "file" };
import crab from "./assets/kenney-cube-pets/Previews/animal-crab.png" with { type: "file" };
import deer from "./assets/kenney-cube-pets/Previews/animal-deer.png" with { type: "file" };
import dog from "./assets/kenney-cube-pets/Previews/animal-dog.png" with { type: "file" };
import elephant from "./assets/kenney-cube-pets/Previews/animal-elephant.png" with { type: "file" };
import fish from "./assets/kenney-cube-pets/Previews/animal-fish.png" with { type: "file" };
import fox from "./assets/kenney-cube-pets/Previews/animal-fox.png" with { type: "file" };
import giraffe from "./assets/kenney-cube-pets/Previews/animal-giraffe.png" with { type: "file" };
import hog from "./assets/kenney-cube-pets/Previews/animal-hog.png" with { type: "file" };
import koala from "./assets/kenney-cube-pets/Previews/animal-koala.png" with { type: "file" };
import lion from "./assets/kenney-cube-pets/Previews/animal-lion.png" with { type: "file" };
import monkey from "./assets/kenney-cube-pets/Previews/animal-monkey.png" with { type: "file" };
import panda from "./assets/kenney-cube-pets/Previews/animal-panda.png" with { type: "file" };
import parrot from "./assets/kenney-cube-pets/Previews/animal-parrot.png" with { type: "file" };
import penguin from "./assets/kenney-cube-pets/Previews/animal-penguin.png" with { type: "file" };
import pig from "./assets/kenney-cube-pets/Previews/animal-pig.png" with { type: "file" };
import polar from "./assets/kenney-cube-pets/Previews/animal-polar.png" with { type: "file" };
import tiger from "./assets/kenney-cube-pets/Previews/animal-tiger.png" with { type: "file" };

/** Path to read each pet's preview PNG from. */
export const PET_PREVIEW_FILES: Record<Pet, string> = {
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
