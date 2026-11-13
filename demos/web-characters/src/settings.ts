// What a page can adjust on a character while it runs.

export type CharacterSettings = {
  /** Size of the character; 1 is the model's own size, 192 CSS pixels tall. The canvas scales with it. */
  scale: number;
  /** How far above the bottom edge of its bounds the character stands, in CSS pixels; negative sinks it below the edge. */
  bottom: number;
};

export const DEFAULT_CHARACTER_SETTINGS: CharacterSettings = { scale: 1, bottom: 0 };
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 8;
export const BOTTOM_MIN = -2000;
export const BOTTOM_MAX = 4000;

/** A finite number kept in range, or the fallback. */
export const clampNumber = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Fills gaps with `current` (the defaults when not given) and keeps every value in range, whatever the source. */
export function sanitizeCharacterSettings(input: unknown, current: CharacterSettings = DEFAULT_CHARACTER_SETTINGS): CharacterSettings {
  const s = (typeof input === "object" && input !== null ? input : {}) as Partial<Record<keyof CharacterSettings, unknown>>;
  return {
    scale: Math.round(clampNumber(s.scale, current.scale, SCALE_MIN, SCALE_MAX) * 100) / 100,
    bottom: Math.round(clampNumber(s.bottom, current.bottom, BOTTOM_MIN, BOTTOM_MAX)),
  };
}
