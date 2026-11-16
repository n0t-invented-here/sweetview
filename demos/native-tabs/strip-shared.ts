// Windows: what the tab strip's page and the UI thread say to each other, and
// the strip's geometry. The geometry is here, not in the stylesheet, because
// both sides need it: the page lays its tabs out with it, and the UI thread
// asks it where a tab dropped on a strip from another window should go.
// No native code and no DOM, so it is tested without a window (strip-shared.test.ts).

export type StripTab = {
  /** The tab's number: counts up from 1, never reused. */
  id: number;
  title: string;
  /** Set for a tab showing the demo's page: the hue that page tints itself with, so the selected tab and its page are one colour. */
  hue?: number;
};

/** Everything a strip shows, sent whole whenever any of it changes. */
export type StripState = {
  /** This window's tabs, left to right. */
  tabs: StripTab[];
  selected: number | null;
  maximized: boolean;
  /** Whether this is the window the user is working in; a strip in the background is dimmed, as a title bar is. */
  active: boolean;
};

/** A place in the strip, in CSS pixels from its top-left corner. */
export type StripPoint = { x: number; y: number };

export type StripMethods = {
  /** The strip's page is up and asks what to show. The window appears once it has. */
  "strip.state": [void, StripState];
  "strip.select": [number, void];
  "strip.close": [number, void];
  /** The + button. */
  "strip.new": [void, void];
  /** A tab was dragged to another place in this strip: `index` is where it is now. */
  "strip.move": [{ id: number; index: number }, void];
  /**
   * A tab was dragged out of the strip, the button still down: it gets a
   * window of its own, which follows the cursor. A window's only tab takes
   * the window with it instead. `held` is where the pointer has the tab, in
   * a strip that shows that tab alone.
   */
  "strip.detach": [{ id: number; held: StripPoint }, void];
  /** A press on the strip's empty part, still down: the window follows the cursor, as by a title bar. `held` is where the press was. */
  "strip.drag": [StripPoint, void];
  /** A press on the strip's top edge, still down: the window is resized from there. */
  "strip.resize": [{ edge: "top" | "top-left" | "top-right"; held: StripPoint }, void];
  "strip.minimize": [void, void];
  /** Maximises, or restores a maximised window. */
  "strip.maximize": [void, void];
  /** The window's close button. */
  "strip.closeWindow": [void, void];
  /** A right-click: on a tab, for the tab's menu; or null for the strip's empty part, where a title bar has the window's menu. */
  "strip.menu": [number | null, void];
  /** The user is done with the strip for now: the keyboard goes back to the page. */
  "strip.focus": [void, void];
  /** How far the row of tabs is scrolled, whenever that changes: the UI thread needs it to know which tab a place in the strip is. */
  "strip.scrolled": [number, void];
  /** Whether the system is in dark mode, as the page sees it. */
  "strip.dark": [boolean, void];
};

export type StripEvents = {
  strip: StripState;
};

// All in CSS pixels.
/** The strip's height: Windows 11's title bar with tabs in it. */
export const STRIP_HEIGHT = 40;
/** Minimise, maximise, close: three buttons of 46. */
export const CAPTION_WIDTH = 138;
/** Space before the first tab. */
export const TABS_LEFT = 8;
export const TAB_MAX_WIDTH = 240;
/** Below this a tab has no room for a word of its title; more tabs than fit at this width scroll. */
export const TAB_MIN_WIDTH = 72;
/** The + after the last tab, with its margin. */
export const NEW_TAB_WIDTH = 40;
/** Kept free at the end of the strip whatever the number of tabs, so there is always somewhere to take the window by. */
export const DRAG_ROOM = 56;

/** How wide each tab is: as wide as the strip allows, within the two limits. `stripWidth` is the whole strip, caption buttons included. */
export function tabWidth(stripWidth: number, count: number): number {
  const room = stripWidth - CAPTION_WIDTH - TABS_LEFT - NEW_TAB_WIDTH - DRAG_ROOM;
  return Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, Math.floor(room / Math.max(1, count))));
}

/** The width the tabs may take before they scroll. */
export const tabsViewport = (stripWidth: number): number => Math.max(TAB_MIN_WIDTH, stripWidth - CAPTION_WIDTH - TABS_LEFT - NEW_TAB_WIDTH - DRAG_ROOM);

/**
 * How far the row of tabs is scrolled so that tab `index` is in view: nothing
 * when they all fit, otherwise the least that shows it whole, from `scrolled`.
 */
export function scrollToShow(stripWidth: number, count: number, index: number, scrolled = 0): number {
  const width = tabWidth(stripWidth, count);
  const viewport = tabsViewport(stripWidth);
  const most = Math.max(0, count * width - viewport);
  const least = Math.max(0, (index + 1) * width - viewport); // its right edge in view
  return Math.max(0, Math.min(most, index * width, Math.max(least, scrolled)));
}

/**
 * Where a tab dropped at `x` (from the strip's left edge) goes among `count`
 * tabs already there: 0 before the first, `count` after the last. A drop on a
 * tab's left half goes before it, on its right half after it.
 */
export function dropIndex(stripWidth: number, count: number, x: number, scrolled = 0): number {
  const width = tabWidth(stripWidth, count);
  return Math.max(0, Math.min(count, Math.round((x - TABS_LEFT + scrolled) / width)));
}
