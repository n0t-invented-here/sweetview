/// <reference path="./assets.d.ts" />
export { createPet, PET_SIZE, type PetHandle, type PetOptions, type Point } from "./pet";
export { clipFor, clipNames, drawMood, sameModel, type ClipRef, type ClipSpec, type Direction, type MoodCommand, type MoodSpec, type PetModel, type Role } from "./model";
export { DEFAULT_PET_SETTINGS, SCALE_MIN, SCALE_MAX, BOTTOM_MIN, BOTTOM_MAX, clampNumber, sanitizePetSettings, type PetSettings } from "./settings";
export { createLife, separate, BODY, HEAD, FEET, GRAVITY, MAX_THROW, type Box, type Life, type LifeState, type World } from "./life";
export { projectToCanvas, proportionsOf, topAt, type Bounds, type Proportions } from "./framing";
