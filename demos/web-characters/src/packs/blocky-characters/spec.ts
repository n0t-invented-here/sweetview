// Kenney's Blocky Characters (CC0): node-animated people with 27 clips, no
// fall and no gestures, modelled eight units tall. The spec, without the
// files; each character's module adds its file and texture.

import type { ModelSpec } from "../../model";

export const blockyCharacterSpec = (name: string, url: string, textures: Record<string, string>): ModelSpec => ({
  name,
  url,
  textures,
  height: 1.3,
  clips: { idle: "idle", carried: "emote-no", landed: { name: "emote-yes", once: true } }, // no falling clip: falls with the carried one
  moods: [
    { name: "idle", clip: "idle", weight: 3, seconds: [2, 6] },
    { name: "walk", clip: "walk", weight: 3, speed: 70, seconds: [3, 8] },
    { name: "sprint", clip: "sprint", weight: 1, speed: 150, seconds: [1.5, 3.5] },
    { name: "sit", clip: "sit", weight: 1, seconds: [3, 6] },
    { name: "pick-up", clip: "pick-up", weight: 1, seconds: [1, 2] },
  ],
});
