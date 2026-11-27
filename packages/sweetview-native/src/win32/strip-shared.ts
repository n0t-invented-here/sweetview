// Windows: tab strip IPC contract and pure layout geometry shared between the
// strip webview and the UI thread. No native code and no DOM.

export type StripTab = {
  /** Monotonic tab id (starts at 1, never reused). */
  id: number;
  title: string;
  /** Optional hue for tinted tabs. */
  hue?: number;
};

/** Everything a strip shows, sent whole whenever any of it changes. */
export type StripState = {
  /** This window's tabs, left to right. */
  tabs: StripTab[];
  selected: number | null;
  maximized: boolean;
  /** Whether this is the active foreground window. */
  active: boolean;
};

/** A place in the strip, in CSS pixels from its top-left corner. */
export type StripPoint = { x: number; y: number };

export type StripMethods = {
  "strip.state": [void, StripState];
  "strip.select": [number, void];
  "strip.close": [number, void];
  "strip.new": [void, void];
  "strip.move": [{ id: number; index: number }, void];
  "strip.detach": [{ id: number; held: StripPoint }, void];
  "strip.drag": [StripPoint, void];
  "strip.resize": [{ edge: "top" | "top-left" | "top-right"; held: StripPoint }, void];
  "strip.minimize": [void, void];
  "strip.maximize": [void, void];
  "strip.closeWindow": [void, void];
  "strip.menu": [number | null, void];
  "strip.focus": [void, void];
  "strip.scrolled": [number, void];
  "strip.dark": [boolean, void];
};

export type StripEvents = {
  strip: StripState;
};

export const STRIP_HEIGHT = 40;
export const CAPTION_WIDTH = 138;
export const TABS_LEFT = 8;
export const TAB_MAX_WIDTH = 240;
export const TAB_MIN_WIDTH = 72;
export const NEW_TAB_WIDTH = 40;
export const DRAG_ROOM = 56;

export function tabWidth(stripWidth: number, count: number): number {
  const room = stripWidth - CAPTION_WIDTH - TABS_LEFT - NEW_TAB_WIDTH - DRAG_ROOM;
  return Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, Math.floor(room / Math.max(1, count))));
}

export const tabsViewport = (stripWidth: number): number =>
  Math.max(TAB_MIN_WIDTH, stripWidth - CAPTION_WIDTH - TABS_LEFT - NEW_TAB_WIDTH - DRAG_ROOM);

export function scrollToShow(stripWidth: number, count: number, index: number, scrolled = 0): number {
  const width = tabWidth(stripWidth, count);
  const viewport = tabsViewport(stripWidth);
  const most = Math.max(0, count * width - viewport);
  const least = Math.max(0, (index + 1) * width - viewport);
  return Math.max(0, Math.min(most, index * width, Math.max(least, scrolled)));
}

export function dropIndex(stripWidth: number, count: number, x: number, scrolled = 0): number {
  const width = tabWidth(stripWidth, count);
  return Math.max(0, Math.min(count, Math.round((x - TABS_LEFT + scrolled) / width)));
}
