// Windows: the tab strip, which is the window's title bar. A page of its own
// in a webview of its own, above the tabs' webviews. It draws the tabs, the +
// and the three caption buttons, and tells the UI thread what the user did
// with them; which tabs exist, their order and their titles are the UI
// thread's (`strip` events), never decided here.
//
// What the window manager does better it is handed: a press on the empty part
// moves the window, a press on the top edge resizes it, and a tab dragged out
// of the strip becomes a window that follows the cursor. Each of those says
// where in the strip the press was: by the time the UI thread hears of it the
// cursor has moved on, and the window is put back under it before the window
// manager takes over, so nothing slips in the hand.

import "./strip.css";

import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import { STRIP_HEIGHT, TABS_LEFT, scrollToShow, tabWidth, tabsViewport, type StripEvents, type StripMethods, type StripState } from "../strip-shared";

const bridge = createBridge<StripMethods, StripEvents>(webviewTransport());
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const strip = element("strip");
const tabsElement = element("tabs");
const newButton = element<HTMLButtonElement>("new");
const maximizeButton = element<HTMLButtonElement>("maximize");

/** How far past the strip's edge a dragged tab goes before it leaves the strip. */
const DETACH_DISTANCE = 28;
/** Below this width a tab that is not selected has no room for its close button. */
const NARROW = 100;
const GLYPH = { maximize: "", restore: "", close: "" }; // Segoe Fluent Icons

let state: StripState = { tabs: [], selected: null, maximized: false, active: true };
/** While a tab is dragged, and until the UI thread has heard where it was dropped: the order on show. */
let order: number[] | undefined;
let scrolled = 0;
/** What the UI thread was last told `scrolled` is. */
let told = 0;
/** A tab dragged out, until the UI thread has taken it away. */
let leaving: number | undefined;
let drag: { id: number; pointer: number; startX: number; startY: number; grab: number; moved: boolean; x: number } | undefined;
const tabElements = new Map<number, HTMLElement>();

const shownTabs = () => (order ? order.flatMap((id) => state.tabs.find((tab) => tab.id === id) ?? []) : state.tabs);

function makeTab(id: number): HTMLElement {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.id = String(id);
  tab.setAttribute("role", "tab");
  const title = document.createElement("span");
  title.className = "title";
  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.tabIndex = -1;
  close.title = "Close tab (Ctrl+W)";
  close.setAttribute("aria-label", "Close tab");
  close.textContent = GLYPH.close;
  tab.append(title, close);
  return tab;
}

/** After `scrolled` changed: the row fades out at an end that has tabs out of sight, and the UI thread hears how far it is scrolled. */
function scrolledTo(count: number, width: number): void {
  const most = Math.max(0, count * width - tabsViewport(innerWidth));
  tabsElement.classList.toggle("more-left", scrolled > 0);
  tabsElement.classList.toggle("more-right", scrolled < most);
  if (scrolled !== told) bridge.notify("strip.scrolled", (told = scrolled));
}

let drawn = false;
function render(): void {
  const tabs = shownTabs();
  const width = tabWidth(innerWidth, tabs.length);
  const selected = tabs.findIndex((tab) => tab.id === state.selected);
  if (!drag) scrolled = scrollToShow(innerWidth, tabs.length, Math.max(0, selected), scrolled);
  const room = Math.min(tabs.length * width, tabsViewport(innerWidth));
  tabsElement.style.width = `${room}px`;
  tabsElement.classList.toggle("narrow", width < NARROW);
  newButton.style.transform = `translateX(${TABS_LEFT + room}px)`;
  scrolledTo(tabs.length, width);

  tabs.forEach((tab, index) => {
    let el = tabElements.get(tab.id);
    if (el === undefined) {
      el = makeTab(tab.id);
      tabElements.set(tab.id, el);
      tabsElement.append(el);
      if (drawn) {
        // a tab opened while the strip is on show fades in where it belongs
        const entering = el;
        entering.classList.add("entering");
        requestAnimationFrame(() => requestAnimationFrame(() => entering.classList.remove("entering")));
      }
    }
    const dragged = drag?.id === tab.id && drag.moved;
    el.style.width = `${width}px`;
    el.style.transform = `translateX(${dragged ? drag!.x : index * width - scrolled}px)`;
    el.classList.toggle("dragging", dragged);
    el.classList.toggle("leaving", leaving === tab.id);
    el.classList.toggle("selected", tab.id === state.selected);
    el.classList.toggle("tinted", tab.hue !== undefined);
    if (tab.hue !== undefined) el.style.setProperty("--hue", String(tab.hue));
    // the hairline between two tabs, where neither is the selected one
    el.classList.toggle("separated", index > 0 && index !== selected && index - 1 !== selected);
    el.setAttribute("aria-selected", String(tab.id === state.selected));
    el.title = tab.title;
    const title = el.firstElementChild!;
    if (title.textContent !== tab.title) title.textContent = tab.title;
  });
  for (const [id, el] of tabElements) {
    if (tabs.some((tab) => tab.id === id)) continue;
    tabElements.delete(id);
    el.remove();
  }

  document.documentElement.classList.toggle("maximized", state.maximized);
  document.documentElement.classList.toggle("inactive", !state.active);
  maximizeButton.textContent = state.maximized ? GLYPH.restore : GLYPH.maximize;
  maximizeButton.title = state.maximized ? "Restore Down" : "Maximize";
  maximizeButton.setAttribute("aria-label", maximizeButton.title);
  drawn = true;
}

function apply(next: StripState): void {
  state = next;
  leaving = undefined;
  const ids = next.tabs.map((tab) => tab.id);
  if (drag?.moved && order && ids.includes(drag.id)) {
    // something changed under a drag in progress: keep what the user has arranged, let go of what closed, add what opened
    order = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order!.includes(id))];
  } else {
    if (drag && !ids.includes(drag.id)) drag = undefined;
    order = undefined;
  }
  render();
}

const tabIdAt = (target: EventTarget | null): number | undefined => {
  const tab = target instanceof Element ? target.closest<HTMLElement>(".tab") : null;
  return tab ? Number(tab.dataset.id) : undefined;
};
const onCloseButton = (target: EventTarget | null) => target instanceof Element && target.closest(".close") !== null;

// --- a tab: press to select, drag along the strip to reorder, drag out of it for a window of its own
tabsElement.addEventListener("pointerdown", (event) => {
  const id = tabIdAt(event.target);
  if (id === undefined || event.button !== 0 || onCloseButton(event.target)) return;
  if (id !== state.selected) bridge.notify("strip.select", id);
  const tabs = shownTabs();
  const x = tabs.findIndex((tab) => tab.id === id) * tabWidth(innerWidth, tabs.length) - scrolled;
  drag = { id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, grab: event.clientX - TABS_LEFT - x, moved: false, x };
  try {
    tabElements.get(id)?.setPointerCapture(event.pointerId); // moves and the release reach us from anywhere on screen
  } catch {
    // a pointer the browser does not know (a synthetic event): the window-level listeners below still hear it
  }
});

window.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointer) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return; // a click that wobbled
  // Pulled out of the strip. A window's only tab has nowhere to go along the strip: it takes the window with it at once.
  if (state.tabs.length === 1 || event.clientY < -DETACH_DISTANCE || event.clientY > STRIP_HEIGHT + DETACH_DISTANCE) {
    const { id, grab, startY } = drag;
    drag = undefined;
    order = undefined;
    if (state.tabs.length > 1) leaving = id;
    render();
    bridge.notify("strip.detach", { id, held: { x: TABS_LEFT + grab, y: startY } });
    return;
  }
  const ids = (order ??= state.tabs.map((tab) => tab.id));
  const width = tabWidth(innerWidth, ids.length);
  drag.moved = true;
  drag.x = Math.max(-scrolled, Math.min((ids.length - 1) * width - scrolled, event.clientX - TABS_LEFT - drag.grab));
  const from = ids.indexOf(drag.id);
  const to = Math.max(0, Math.min(ids.length - 1, Math.round((drag.x + scrolled) / width)));
  if (to !== from) ids.splice(to, 0, ...ids.splice(from, 1));
  render();
});

function endDrag(event: PointerEvent, dropped: boolean): void {
  if (!drag || event.pointerId !== drag.pointer) return;
  const { id, moved } = drag;
  drag = undefined;
  const index = order?.indexOf(id) ?? -1;
  if (dropped && moved && index !== -1 && index !== state.tabs.findIndex((tab) => tab.id === id)) {
    bridge.notify("strip.move", { id, index }); // `order` stays on show until the UI thread's own order arrives
  } else {
    order = undefined;
  }
  render();
  bridge.notify("strip.focus");
}
window.addEventListener("pointerup", (event) => endDrag(event, true));
window.addEventListener("pointercancel", (event) => endDrag(event, false));

tabsElement.addEventListener("click", (event) => {
  const id = tabIdAt(event.target);
  if (id !== undefined && onCloseButton(event.target)) bridge.notify("strip.close", id);
});
// A middle click closes the tab under it; its press must not start the browser's autoscroll.
tabsElement.addEventListener("mousedown", (event) => {
  if (event.button === 1) event.preventDefault();
});
tabsElement.addEventListener("auxclick", (event) => {
  const id = tabIdAt(event.target);
  if (event.button === 1 && id !== undefined) bridge.notify("strip.close", id);
});

newButton.addEventListener("click", () => {
  bridge.notify("strip.new");
  bridge.notify("strip.focus");
});

// --- the rest of the strip is the title bar
strip.addEventListener("mousedown", (event) => {
  const target = event.target as Element;
  if (event.button !== 0 || target.closest(".tab, button")) return;
  const held = { x: event.clientX, y: event.clientY };
  const edge = target.closest<HTMLElement>(".edge")?.dataset.edge as "top" | "top-left" | "top-right" | undefined;
  if (edge !== undefined) bridge.notify("strip.resize", { edge, held });
  else if (event.detail === 2) bridge.notify("strip.maximize"); // the second press of a double-click
  else bridge.notify("strip.drag", held);
});
element("minimize").addEventListener("click", () => bridge.notify("strip.minimize"));
maximizeButton.addEventListener("click", () => bridge.notify("strip.maximize"));
element("close").addEventListener("click", () => bridge.notify("strip.closeWindow"));

window.addEventListener("contextmenu", (event) => {
  event.preventDefault(); // the browser's menu has nothing for a title bar
  if (!(event.target instanceof Element) || event.target.closest("#caption")) return;
  bridge.notify("strip.menu", tabIdAt(event.target) ?? null);
});

window.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault(); // Ctrl+wheel would zoom the title bar
    if (event.ctrlKey) return;
    const tabs = shownTabs();
    const most = Math.max(0, tabs.length * tabWidth(innerWidth, tabs.length) - tabsViewport(innerWidth));
    const to = Math.max(0, Math.min(most, scrolled + event.deltaY + event.deltaX));
    if (to === scrolled) return;
    scrolled = to;
    // render() brings the selected tab back into view; a wheel may leave it out of sight
    const width = tabWidth(innerWidth, tabs.length);
    tabs.forEach((tab, index) => tabElements.get(tab.id)?.style.setProperty("transform", `translateX(${index * width - scrolled}px)`));
    scrolledTo(tabs.length, width);
  },
  { passive: false },
);
window.addEventListener("resize", render);
window.addEventListener("dragstart", (event) => event.preventDefault());

const darkMode = matchMedia("(prefers-color-scheme: dark)");
const tellDark = () => bridge.notify("strip.dark", darkMode.matches);
darkMode.addEventListener("change", tellDark);
tellDark();

let heard = false;
bridge.on("strip", (next) => {
  heard = true;
  apply(next);
});
const first = await bridge.rpc("strip.state");
if (!heard) apply(first); // an event that overtook this answer is the newer state
