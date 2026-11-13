// Kenney's Cube Pets, with their files. Each animal is its own module
// (`@n1h/web-pets/packs/cube-pets/cat`), importing its own glTF, so a build
// that imports the cat ships the cat's file and nothing else of the pack.
// This module imports all 24, for a page that wants the whole pack and
// ships it.

import type { PetModel } from "../../model";
import type { Pet } from "./spec";
export { PETS, BIRDS, isBird, isPet, petLabel, randomPet, type Pet, type PetAnimation } from "./spec";
import { beaver } from "./beaver";
import { bee } from "./bee";
import { bunny } from "./bunny";
import { cat } from "./cat";
import { caterpillar } from "./caterpillar";
import { chick } from "./chick";
import { cow } from "./cow";
import { crab } from "./crab";
import { deer } from "./deer";
import { dog } from "./dog";
import { elephant } from "./elephant";
import { fish } from "./fish";
import { fox } from "./fox";
import { giraffe } from "./giraffe";
import { hog } from "./hog";
import { koala } from "./koala";
import { lion } from "./lion";
import { monkey } from "./monkey";
import { panda } from "./panda";
import { parrot } from "./parrot";
import { penguin } from "./penguin";
import { pig } from "./pig";
import { polar } from "./polar";
import { tiger } from "./tiger";

export { beaver, bee, bunny, cat, caterpillar, chick, cow, crab, deer, dog, elephant, fish, fox, giraffe, hog, koala, lion, monkey, panda, parrot, penguin, pig, polar, tiger };

export const CUBE_PETS: Readonly<Record<Pet, PetModel>> = { beaver, bee, bunny, cat, caterpillar, chick, cow, crab, deer, dog, elephant, fish, fox, giraffe, hog, koala, lion, monkey, panda, parrot, penguin, pig, polar, tiger };
