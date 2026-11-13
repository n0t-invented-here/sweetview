// What a pet is made of, as data: which file, how to fit it, which clips
// play for which states, and which moods it draws from on the ground. The
// packs in src/packs are specs of this shape, one named export per model;
// a page passes its own for any glTF with animations.

export type Direction = -1 | 1;

/** A clip in the model's file, by its animation-group name. */
export type ClipSpec =
  | string
  | {
      name: string;
      /** Play through once rather than loop. A `landed` clip played once sets how long the landing lasts. */
      once?: boolean;
    };

/** Something to do on the ground: a clip, for a while, with a weight in the draw and a speed when it moves. */
export type MoodSpec = {
  name: string;
  clip: string;
  /** How likely, against the other moods. 1 by default. */
  weight?: number;
  /** How long it lasts, drawn between these two, in seconds. */
  seconds: [number, number];
  /** Movement along the ground while it plays, in CSS pixels per second at scale 1; tuned to the clip's stride so the feet do not slide. None: stands still. */
  speed?: number;
};

export type PetModel = {
  /** For labels. */
  name: string;
  /** Where the glTF is fetched from: an imported file (`import url from "./robot.glb"`), so the build ships it, or any URL. */
  url: string;
  /**
   * Where the textures the file references by relative path are fetched
   * from, by that path: `{ "Textures/colormap.png": colormapUrl }`. A
   * bundler renames files, so a texture beside the glTF is found only
   * through this. Not needed for a glTF with its textures embedded.
   */
  textures?: Record<string, string>;
  /** Fit the model to this height in scene units (the cube pets are about 1 to 1.4). None: as modelled. */
  height?: number;
  /** Which way the model faces as modelled. `+z` by default. */
  forward?: "+z" | "-z" | "+x" | "-x";
  clips: {
    idle: ClipSpec;
    /** While held by the pointer. `idle` when missing. */
    carried?: ClipSpec;
    /** While falling. `carried` when missing. */
    falling?: ClipSpec;
    /** Just after a landing. `idle` when missing. */
    landed?: ClipSpec;
  };
  /** What it does on the ground. At least one; a mood whose clip the file lacks is dropped at load. */
  moods: MoodSpec[];
};

export type Role = "idle" | "carried" | "falling" | "landed";
export type ClipRef = { name: string; once: boolean };

const asRef = (spec: ClipSpec): ClipRef => (typeof spec === "string" ? { name: spec, once: false } : { name: spec.name, once: spec.once ?? false });

/** The clip for a state, with the fallbacks (falling → carried → idle, landed → idle). */
export function clipFor(model: PetModel, role: Role): ClipRef {
  const c = model.clips;
  switch (role) {
    case "idle":
      return asRef(c.idle);
    case "carried":
      return asRef(c.carried ?? c.idle);
    case "falling":
      return asRef(c.falling ?? c.carried ?? c.idle);
    case "landed":
      return asRef(c.landed ?? c.idle);
  }
}

/** Every clip name the model uses. */
export const clipNames = (model: PetModel): string[] => [
  ...new Set([...(["idle", "carried", "falling", "landed"] as const).map((r) => clipFor(model, r).name), ...model.moods.map((m) => m.clip)]),
];

export type MoodCommand = { mood: MoodSpec; dir: Direction; seconds: number };

/** A weighted draw from the model's moods, with a direction and a length. `has` leaves out moods whose clip is not in the file. */
export function drawMood(model: PetModel, has: (clip: string) => boolean = () => true): MoodCommand {
  const moods = model.moods.filter((m) => has(m.clip));
  const pool = moods.length ? moods : model.moods;
  const total = pool.reduce((sum, m) => sum + (m.weight ?? 1), 0);
  let r = Math.random() * total;
  let mood = pool[pool.length - 1]!;
  for (const m of pool) {
    r -= m.weight ?? 1;
    if (r < 0) {
      mood = m;
      break;
    }
  }
  const [lo, hi] = mood.seconds;
  return { mood, dir: Math.random() < 0.5 ? -1 : 1, seconds: lo + Math.random() * (hi - lo) };
}

/** The same model, by what it loads from. */
export const sameModel = (a: PetModel, b: PetModel): boolean => a.url === b.url;
