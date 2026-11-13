// What the user can adjust, with the file it lives in. Shared by the UI
// thread (owns the current values, saves them), the pet page (applies them)
// and the settings page (edits them). The ranges are the web pets'.

import { BOTTOM_MAX, BOTTOM_MIN, clampNumber, SCALE_MAX, SCALE_MIN } from "@n1h/web-characters";

export type Settings = {
  /** How far above the very bottom of the display the pet stands, in CSS pixels (the same visual distance on every monitor, whatever its scale factor); negative sinks it below the edge. */
  bottom: number;
  /** Size of the pet (the 3D model, and with it the window and the hit boxes); 1 is the model's own size. */
  scale: number;
  /** Clicks beside the pet fall through to whatever is underneath. Off: the whole window takes clicks. */
  clickThrough: boolean;
};

export const DEFAULT_SETTINGS: Settings = { bottom: 0, scale: 1, clickThrough: true };
export { BOTTOM_MAX, BOTTOM_MIN, SCALE_MAX, SCALE_MIN };

/** Fills gaps with defaults and keeps every value in range, whatever the source. */
export function sanitize(input: unknown): Settings {
  const s = (typeof input === "object" && input !== null ? input : {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    bottom: Math.round(clampNumber(s.bottom, DEFAULT_SETTINGS.bottom, BOTTOM_MIN, BOTTOM_MAX)),
    scale: Math.round(clampNumber(s.scale, DEFAULT_SETTINGS.scale, SCALE_MIN, SCALE_MAX) * 100) / 100,
    clickThrough: typeof s.clickThrough === "boolean" ? s.clickThrough : DEFAULT_SETTINGS.clickThrough,
  };
}
