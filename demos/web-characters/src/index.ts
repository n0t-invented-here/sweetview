/// <reference path="./assets.d.ts" />
export { createCharacter, CHARACTER_SIZE, type CharacterHandle, type CharacterOptions, type Point } from "./character";
export { clipFor, clipNames, drawMood, sameModel, type ClipRef, type ClipSpec, type Direction, type MoodCommand, type MoodSpec, type ModelSpec, type Role } from "./model";
export { DEFAULT_CHARACTER_SETTINGS, SCALE_MIN, SCALE_MAX, BOTTOM_MIN, BOTTOM_MAX, clampNumber, sanitizeCharacterSettings, type CharacterSettings } from "./settings";
export { createLife, separate, BODY, HEAD, FEET, GRAVITY, MAX_THROW, type Box, type Life, type LifeState, type World } from "./life";
export { projectToCanvas, proportionsOf, topAt, type Bounds, type Proportions } from "./framing";
