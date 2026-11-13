// Kenney's Mini Characters (CC0): skinned people with 32 clips, none of
// which are the pets'. The spec, without the files; each character's module
// adds its file.

import type { PetModel } from "../../model";

export const TEXTURE_FILE = "Textures/colormap.png";

export const miniCharacterSpec = (name: string, url: string, textures: Record<string, string>): PetModel => ({
  name,
  url,
  textures,
  height: 1.3, // modelled about 0.75 tall; the pets are 1 to 1.4
  clips: { idle: "idle", carried: "emote-no", falling: "fall", landed: { name: "emote-yes", once: true } },
  moods: [
    { name: "idle", clip: "idle", weight: 3, seconds: [2, 6] },
    { name: "walk", clip: "walk", weight: 3, speed: 70, seconds: [3, 8] }, // a 0.67 s cycle; the stride is a guess from the leg length
    { name: "sprint", clip: "sprint", weight: 1, speed: 150, seconds: [1.5, 3.5] },
    { name: "jump", clip: "jump", weight: 1, seconds: [1, 2] },
    { name: "sit", clip: "sit", weight: 0.5, seconds: [2, 4] }, // now and then, not a habit
  ],
});
