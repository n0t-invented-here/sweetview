// Kenney's Mini Characters (CC0): skinned people with 32 clips, none of
// which are the pets'. Six of them, in assets/kenney-mini-characters.

import type { PetModel } from "../model";

const MINI = ["female-a", "female-b", "female-c", "male-a", "male-b", "male-c"] as const;

const spec = (id: (typeof MINI)[number]): PetModel => ({
  name: `Mini ${id}`,
  pack: "kenney-mini-characters",
  file: `character-${id}.glb`,
  height: 1.3, // modelled about 0.75 tall; the pets are 1 to 1.4
  clips: { idle: "idle", carried: "emote-no", falling: "fall", landed: { name: "emote-yes", once: true } },
  moods: [
    { name: "idle", clip: "idle", weight: 3, seconds: [2, 6] },
    { name: "walk", clip: "walk", weight: 3, speed: 70, seconds: [3, 8] }, // a 0.67 s cycle; the stride is a guess from the leg length
    { name: "sprint", clip: "sprint", weight: 1, speed: 150, seconds: [1.5, 3.5] },
    { name: "jump", clip: "jump", weight: 1, seconds: [1, 2] },
    { name: "crouch", clip: "crouch", weight: 1, seconds: [2, 4] },
    { name: "sit", clip: "sit", weight: 1, seconds: [3, 6] },
  ],
});

export const MINI_CHARACTERS: readonly PetModel[] = MINI.map(spec);
