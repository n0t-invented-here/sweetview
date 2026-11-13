// Kenney's Blocky Characters (CC0): node-animated people with 27 clips, no
// fall and no gestures, modelled eight units tall and facing -x. Four of them, in
// assets/kenney-blocky-characters.

import type { PetModel } from "../model";

const BLOCKY = ["a", "b", "c", "d"] as const;

const spec = (id: (typeof BLOCKY)[number]): PetModel => ({
  name: `Blocky ${id.toUpperCase()}`,
  pack: "kenney-blocky-characters",
  file: `character-${id}.glb`,
  height: 1.3,
  forward: "-x", // modelled facing along -x; the pets face +z
  clips: { idle: "idle", carried: "emote-no", landed: { name: "emote-yes", once: true } }, // no falling clip: falls with the carried one
  moods: [
    { name: "idle", clip: "idle", weight: 3, seconds: [2, 6] },
    { name: "walk", clip: "walk", weight: 3, speed: 70, seconds: [3, 8] },
    { name: "sprint", clip: "sprint", weight: 1, speed: 150, seconds: [1.5, 3.5] },
    { name: "sit", clip: "sit", weight: 1, seconds: [3, 6] },
    { name: "pick-up", clip: "pick-up", weight: 1, seconds: [1, 2] },
  ],
});

export const BLOCKY_CHARACTERS: readonly PetModel[] = BLOCKY.map(spec);
