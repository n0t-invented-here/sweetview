import { expect, test } from "bun:test";
import { CAPTION_WIDTH, DRAG_ROOM, NEW_TAB_WIDTH, TABS_LEFT, TAB_MAX_WIDTH, TAB_MIN_WIDTH, dropIndex, scrollToShow, tabWidth, tabsViewport } from "./strip-shared";

const STRIP = 1040;

test("a few tabs are as wide as a tab gets; many share the room; none is narrower than the least", () => {
  expect(tabWidth(STRIP, 1)).toBe(TAB_MAX_WIDTH);
  expect(tabWidth(STRIP, 3)).toBe(TAB_MAX_WIDTH);
  const room = STRIP - CAPTION_WIDTH - TABS_LEFT - NEW_TAB_WIDTH - DRAG_ROOM;
  expect(tabWidth(STRIP, 10)).toBe(Math.floor(room / 10));
  expect(tabWidth(STRIP, 10) * 10).toBeLessThanOrEqual(tabsViewport(STRIP));
  expect(tabWidth(STRIP, 200)).toBe(TAB_MIN_WIDTH);
  expect(tabWidth(STRIP, 0)).toBe(TAB_MAX_WIDTH);
});

test("the + and somewhere to take the window by always fit beside the tabs", () => {
  for (const strip of [560, 800, 1040, 2560]) {
    for (const count of [1, 5, 40]) {
      const shown = Math.min(count * tabWidth(strip, count), tabsViewport(strip));
      expect(TABS_LEFT + shown + NEW_TAB_WIDTH + DRAG_ROOM + CAPTION_WIDTH).toBeLessThanOrEqual(strip);
    }
  }
});

test("tabs that all fit are never scrolled", () => {
  expect(scrollToShow(STRIP, 5, 4)).toBe(0);
  expect(scrollToShow(STRIP, 5, 0, 300)).toBe(0);
});

test("more tabs than fit scroll just far enough to show the one asked for", () => {
  const count = 40;
  const width = tabWidth(STRIP, count);
  const viewport = tabsViewport(STRIP);
  expect(width).toBe(TAB_MIN_WIDTH);
  expect(scrollToShow(STRIP, count, 0)).toBe(0);
  const last = scrollToShow(STRIP, count, count - 1);
  expect(last).toBe(count * width - viewport);
  expect(scrollToShow(STRIP, count, count - 1, last)).toBe(last);
  expect(scrollToShow(STRIP, count, 0, last)).toBe(0);
  const middle = scrollToShow(STRIP, count, 20, 0);
  expect(20 * width).toBeGreaterThanOrEqual(middle);
  expect(21 * width).toBeLessThanOrEqual(middle + viewport);
});

test("a tab dropped on a strip goes before the tab whose left half it lands on, after the one whose right half", () => {
  const width = tabWidth(STRIP, 3);
  expect(dropIndex(STRIP, 3, 0)).toBe(0);
  expect(dropIndex(STRIP, 3, TABS_LEFT + width * 0.4)).toBe(0);
  expect(dropIndex(STRIP, 3, TABS_LEFT + width * 0.6)).toBe(1);
  expect(dropIndex(STRIP, 3, TABS_LEFT + width * 2.4)).toBe(2);
  expect(dropIndex(STRIP, 3, TABS_LEFT + width * 2.6)).toBe(3);
  expect(dropIndex(STRIP, 3, STRIP)).toBe(3);
});

test("on a strip whose tabs are scrolled, the drop index counts the tabs scrolled out of view", () => {
  const count = 40;
  const width = tabWidth(STRIP, count);
  const scrolled = scrollToShow(STRIP, count, count - 1); // the last tab shown: scrolled as far as it goes
  expect(scrolled).toBeGreaterThan(0);
  // The left half of the first tab in view goes before it; that tab is the one scrolled to the left edge.
  const firstInView = Math.ceil(scrolled / width);
  const xOfFirstInView = TABS_LEFT + firstInView * width - scrolled;
  expect(dropIndex(STRIP, count, xOfFirstInView + width * 0.4, scrolled)).toBe(firstInView);
  expect(dropIndex(STRIP, count, xOfFirstInView + width * 0.6, scrolled)).toBe(firstInView + 1);
  // The same point on an unscrolled strip is a different index.
  expect(dropIndex(STRIP, count, xOfFirstInView + width * 0.4)).toBe(Math.round((xOfFirstInView + width * 0.4 - TABS_LEFT) / width));
  expect(dropIndex(STRIP, count, xOfFirstInView + width * 0.4)).not.toBe(firstInView);
  // A point at the strip's left edge, scrolled by exactly one tab, is before the second tab; far right is the end.
  expect(dropIndex(STRIP, count, TABS_LEFT, width)).toBe(1);
  expect(dropIndex(STRIP, count, STRIP, scrolled)).toBe(count);
});
