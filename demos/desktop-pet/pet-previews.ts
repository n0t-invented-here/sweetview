// Where each pet's preview picture comes from (Kenney's own 64x64 renders, in
// the pack's Previews/ folder), as paths `bun build --compile` embeds. One
// static import per file, like pet-models.ts. They are the app's icons: the
// tray, the Pet menu, the settings window and the Dock show the current pet.

import type { Pet } from "./pets";

import beaver from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-beaver.png" with { type: "file" };
import bee from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-bee.png" with { type: "file" };
import bunny from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-bunny.png" with { type: "file" };
import cat from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-cat.png" with { type: "file" };
import caterpillar from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-caterpillar.png" with { type: "file" };
import chick from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-chick.png" with { type: "file" };
import cow from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-cow.png" with { type: "file" };
import crab from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-crab.png" with { type: "file" };
import deer from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-deer.png" with { type: "file" };
import dog from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-dog.png" with { type: "file" };
import elephant from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-elephant.png" with { type: "file" };
import fish from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-fish.png" with { type: "file" };
import fox from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-fox.png" with { type: "file" };
import giraffe from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-giraffe.png" with { type: "file" };
import hog from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-hog.png" with { type: "file" };
import koala from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-koala.png" with { type: "file" };
import lion from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-lion.png" with { type: "file" };
import monkey from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-monkey.png" with { type: "file" };
import panda from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-panda.png" with { type: "file" };
import parrot from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-parrot.png" with { type: "file" };
import penguin from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-penguin.png" with { type: "file" };
import pig from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-pig.png" with { type: "file" };
import polar from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-polar.png" with { type: "file" };
import tiger from "@n1h/web-characters/assets/kenney-cube-pets/Previews/animal-tiger.png" with { type: "file" };

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
