// Self-contained built-in Windows 11 tab strip assets (HTML body, CSS, and
// browser JS) served directly to the strip WebView2 with zero external build
// step — works identically under `bun run`, `bun build --compile`, and raw npm
// package source.

export const STRIP_BODY = `<div id="strip">
<div id="tabs" role="tablist" aria-label="Tabs"></div>
<button id="new" type="button" tabindex="-1" title="New tab (Ctrl+T)" aria-label="New tab">&#xE710;</button>
<div id="caption">
<button id="minimize" type="button" tabindex="-1" title="Minimize" aria-label="Minimize">&#xE921;</button>
<button id="maximize" type="button" tabindex="-1"></button>
<button id="close" type="button" tabindex="-1" title="Close" aria-label="Close">&#xE8BB;</button>
</div>
<div class="edge" data-edge="top"></div><div class="edge" data-edge="top-left"></div><div class="edge" data-edge="top-right"></div>
</div>`;

export const STRIP_CSS = `:root {
  color-scheme: light dark;
  --strip: #e9eaee;
  --tab: #f9f9fb;
  --text: #1b1b1f;
  --muted: #5c5d66;
  --hover: rgb(0 0 0 / 0.06);
  --press: rgb(0 0 0 / 0.1);
  --line: rgb(0 0 0 / 0.16);
  --focus: #0067c0;
  font: 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
}
/* data-theme carries the frame's effective appearance (explicit "light" or
   "dark" frames ignore the OS setting); before it is set the OS setting applies. */
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] {
  color-scheme: dark;
  --strip: #292a30;
  --tab: #15161a;
  --text: #f2f2f5;
  --muted: #a6a7b0;
  --hover: rgb(255 255 255 / 0.08);
  --press: rgb(255 255 255 / 0.05);
  --line: rgb(255 255 255 / 0.18);
  --focus: #4cc2ff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --strip: #292a30;
    --tab: #15161a;
    --text: #f2f2f5;
    --muted: #a6a7b0;
    --hover: rgb(255 255 255 / 0.08);
    --press: rgb(255 255 255 / 0.05);
    --line: rgb(255 255 255 / 0.18);
    --focus: #4cc2ff;
  }
}
html, body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: var(--strip);
  color: var(--text);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
#strip { position: fixed; inset: 0; }
button { padding: 0; border: 0; background: none; color: inherit; cursor: default; }
button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
#tabs { position: absolute; left: 8px; top: 8px; bottom: 0; overflow: hidden; }
.tab {
  position: absolute; left: 0; top: 0; box-sizing: border-box; height: 32px;
  display: flex; align-items: center; gap: 2px; padding: 0 4px 0 12px;
  border-radius: 8px 8px 0 0; color: var(--muted);
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1), width 180ms cubic-bezier(0.2, 0, 0, 1), opacity 140ms linear;
}
.tab:hover { background: var(--hover); color: var(--text); }
.tab.selected { background: var(--tab); color: var(--text); }
.tab.selected.tinted { background: oklch(98.5% 0.006 var(--hue)); }
:root[data-theme="dark"] .tab.selected.tinted { background: oklch(19% 0.012 var(--hue)); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .tab.selected.tinted { background: oklch(19% 0.012 var(--hue)); }
}
#tabs.more-left { mask-image: linear-gradient(to right, transparent, #000 28px); }
#tabs.more-right { mask-image: linear-gradient(to left, transparent, #000 28px); }
#tabs.more-left.more-right { mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent); }
.tab.separated::before { content: ""; position: absolute; left: 0; top: 9px; width: 1px; height: 14px; background: var(--line); }
.tab.separated:hover::before, .tab.dragging::before { display: none; }
.tab.entering { opacity: 0; }
.tab.leaving { opacity: 0.35; }
.tab.dragging { z-index: 2; transition: none; }
.tab.dragging:not(.selected) { background: var(--hover); }
.title { flex: 1; min-width: 0; overflow: hidden; line-height: 32px; white-space: nowrap; text-overflow: ellipsis; }
.close { flex: none; width: 24px; height: 24px; border-radius: 4px; font: 8px/24px "Segoe Fluent Icons", "Segoe MDL2 Assets"; opacity: 0; }
.tab:hover .close, .tab.selected .close { opacity: 1; }
.narrow .tab:not(.selected) { padding-right: 8px; }
.narrow .tab:not(.selected) .close { display: none; }
.close:hover { background: var(--hover); }
.close:active { background: var(--press); }
#new {
  position: absolute; left: 4px; top: 10px; width: 32px; height: 28px; border-radius: 6px;
  font: 11px/28px "Segoe Fluent Icons", "Segoe MDL2 Assets";
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
}
#new:hover { background: var(--hover); }
#new:active { background: var(--press); }
#caption { position: absolute; top: 0; right: 0; height: 100%; display: flex; }
#caption button { width: 46px; height: 100%; font: 10px/1 "Segoe Fluent Icons", "Segoe MDL2 Assets"; }
#caption button:hover { background: var(--hover); }
#caption button:active { background: var(--press); }
#caption #close:hover { background: #c42b1c; color: #fff; }
#caption #close:active { background: #c84031; color: rgb(255 255 255 / 0.8); }
.inactive .tab, .inactive .tab.selected, .inactive #new, .inactive #caption button:not(:hover) { color: var(--muted); }
.edge { position: absolute; top: 0; z-index: 5; }
.edge[data-edge="top"] { left: 8px; right: 8px; height: 4px; cursor: ns-resize; }
.edge[data-edge="top-left"] { left: 0; width: 8px; height: 8px; cursor: nwse-resize; }
.edge[data-edge="top-right"] { right: 0; width: 8px; height: 8px; cursor: nesw-resize; }
.maximized .edge { display: none; }
@media (prefers-reduced-motion: reduce) { .tab, #new { transition: none; } }
`;

export const STRIP_JS = `
const STRIP_HEIGHT = 40;
const CAPTION_WIDTH = 138;
const TABS_LEFT = 8;
const TAB_MAX_WIDTH = 240;
const TAB_MIN_WIDTH = 72;
const NEW_TAB_WIDTH = 40;
const DRAG_ROOM = 56;
const DETACH_DISTANCE = 28;
const NARROW = 100;
const GLYPH = { maximize: "\\uE922", restore: "\\uE923", close: "\\uE8BB" };

const tabWidth = (sw, count) => {
  const room = sw - CAPTION_WIDTH - TABS_LEFT - NEW_TAB_WIDTH - DRAG_ROOM;
  return Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, Math.floor(room / Math.max(1, count))));
};
const tabsViewport = (sw) => Math.max(TAB_MIN_WIDTH, sw - CAPTION_WIDTH - TABS_LEFT - NEW_TAB_WIDTH - DRAG_ROOM);
const scrollToShow = (sw, count, index, sc = 0) => {
  const width = tabWidth(sw, count);
  const viewport = tabsViewport(sw);
  const most = Math.max(0, count * width - viewport);
  const least = Math.max(0, (index + 1) * width - viewport);
  return Math.max(0, Math.min(most, index * width, Math.max(least, sc)));
};

const listeners = new Set();
window.__sweetview_emit = (name, payload) => { for (const fn of listeners) fn(name, payload); };
const rpc = (method, params = null) => window.__sweetview_rpc(method, params);
const notify = (method, params = null) => { rpc(method, params).catch(() => {}); };

const element = (id) => document.getElementById(id);
const strip = element("strip");
const tabsElement = element("tabs");
const newButton = element("new");
const maximizeButton = element("maximize");

let state = { tabs: [], selected: null, maximized: false, active: true };
let order;
let scrolled = 0;
let told = 0;
let leaving;
let drag;
const tabElements = new Map();

const shownTabs = () => (order ? order.flatMap((id) => state.tabs.find((t) => t.id === id) ?? []) : state.tabs);

function makeTab(id) {
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

function scrolledTo(count, width) {
  const most = Math.max(0, count * width - tabsViewport(innerWidth));
  tabsElement.classList.toggle("more-left", scrolled > 0);
  tabsElement.classList.toggle("more-right", scrolled < most);
  if (scrolled !== told) notify("strip.scrolled", (told = scrolled));
}

let drawn = false;
function render() {
  const tabs = shownTabs();
  const width = tabWidth(innerWidth, tabs.length);
  const selected = tabs.findIndex((t) => t.id === state.selected);
  if (!drag) scrolled = scrollToShow(innerWidth, tabs.length, Math.max(0, selected), scrolled);
  const room = Math.min(tabs.length * width, tabsViewport(innerWidth));
  tabsElement.style.width = room + "px";
  tabsElement.classList.toggle("narrow", width < NARROW);
  newButton.style.transform = "translateX(" + (TABS_LEFT + room) + "px)";
  scrolledTo(tabs.length, width);

  tabs.forEach((tab, index) => {
    let el = tabElements.get(tab.id);
    if (el === undefined) {
      el = makeTab(tab.id);
      tabElements.set(tab.id, el);
      tabsElement.append(el);
      if (drawn) {
        const entering = el;
        entering.classList.add("entering");
        requestAnimationFrame(() => requestAnimationFrame(() => entering.classList.remove("entering")));
      }
    }
    const dragged = drag?.id === tab.id && drag.moved;
    el.style.width = width + "px";
    el.style.transform = "translateX(" + (dragged ? drag.x : index * width - scrolled) + "px)";
    el.classList.toggle("dragging", !!dragged);
    el.classList.toggle("leaving", leaving === tab.id);
    el.classList.toggle("selected", tab.id === state.selected);
    el.classList.toggle("tinted", tab.hue !== undefined);
    if (tab.hue !== undefined) el.style.setProperty("--hue", String(tab.hue));
    el.classList.toggle("separated", index > 0 && index !== selected && index - 1 !== selected);
    el.setAttribute("aria-selected", String(tab.id === state.selected));
    el.title = tab.title;
    const title = el.firstElementChild;
    if (title.textContent !== tab.title) title.textContent = tab.title;
  });
  for (const [id, el] of tabElements) {
    if (tabs.some((t) => t.id === id)) continue;
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

function apply(next) {
  state = next;
  leaving = undefined;
  const ids = next.tabs.map((t) => t.id);
  if (drag?.moved && order && ids.includes(drag.id)) {
    order = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
  } else {
    if (drag && !ids.includes(drag.id)) drag = undefined;
    order = undefined;
  }
  render();
}

const tabIdAt = (target) => {
  const tab = target instanceof Element ? target.closest(".tab") : null;
  return tab ? Number(tab.dataset.id) : undefined;
};
const onCloseButton = (target) => target instanceof Element && target.closest(".close") !== null;

tabsElement.addEventListener("pointerdown", (event) => {
  const id = tabIdAt(event.target);
  if (id === undefined || event.button !== 0 || onCloseButton(event.target)) return;
  if (id !== state.selected) notify("strip.select", id);
  const tabs = shownTabs();
  const x = tabs.findIndex((t) => t.id === id) * tabWidth(innerWidth, tabs.length) - scrolled;
  drag = { id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, grab: event.clientX - TABS_LEFT - x, moved: false, x };
  try { tabElements.get(id)?.setPointerCapture(event.pointerId); } catch {}
});

window.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointer) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
  if (state.tabs.length === 1 || event.clientY < -DETACH_DISTANCE || event.clientY > STRIP_HEIGHT + DETACH_DISTANCE) {
    const { id, grab, startY } = drag;
    drag = undefined;
    order = undefined;
    if (state.tabs.length > 1) leaving = id;
    render();
    notify("strip.detach", { id, held: { x: TABS_LEFT + grab, y: startY } });
    return;
  }
  const ids = (order ??= state.tabs.map((t) => t.id));
  const width = tabWidth(innerWidth, ids.length);
  drag.moved = true;
  drag.x = Math.max(-scrolled, Math.min((ids.length - 1) * width - scrolled, event.clientX - TABS_LEFT - drag.grab));
  const from = ids.indexOf(drag.id);
  const to = Math.max(0, Math.min(ids.length - 1, Math.round((drag.x + scrolled) / width)));
  if (to !== from) ids.splice(to, 0, ...ids.splice(from, 1));
  render();
});

function endDrag(event, dropped) {
  if (!drag || event.pointerId !== drag.pointer) return;
  const { id, moved } = drag;
  drag = undefined;
  const index = order?.indexOf(id) ?? -1;
  if (dropped && moved && index !== -1 && index !== state.tabs.findIndex((t) => t.id === id)) {
    notify("strip.move", { id, index });
  } else {
    order = undefined;
  }
  render();
  notify("strip.focus");
}
window.addEventListener("pointerup", (event) => endDrag(event, true));
window.addEventListener("pointercancel", (event) => endDrag(event, false));

tabsElement.addEventListener("click", (event) => {
  const id = tabIdAt(event.target);
  if (id !== undefined && onCloseButton(event.target)) notify("strip.close", id);
});
tabsElement.addEventListener("mousedown", (event) => { if (event.button === 1) event.preventDefault(); });
tabsElement.addEventListener("auxclick", (event) => {
  const id = tabIdAt(event.target);
  if (event.button === 1 && id !== undefined) notify("strip.close", id);
});

newButton.addEventListener("click", () => { notify("strip.new"); notify("strip.focus"); });
strip.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (event.button !== 0 || target.closest(".tab, button")) return;
  const held = { x: event.clientX, y: event.clientY };
  const edge = target.closest(".edge")?.dataset.edge;
  if (edge !== undefined) notify("strip.resize", { edge, held });
  else if (event.detail === 2) notify("strip.maximize");
  else notify("strip.drag", held);
});
element("minimize").addEventListener("click", () => notify("strip.minimize"));
maximizeButton.addEventListener("click", () => notify("strip.maximize"));
element("close").addEventListener("click", () => notify("strip.closeWindow"));

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (!(event.target instanceof Element) || event.target.closest("#caption")) return;
  notify("strip.menu", tabIdAt(event.target) ?? null);
});

window.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (event.ctrlKey) return;
  const tabs = shownTabs();
  const most = Math.max(0, tabs.length * tabWidth(innerWidth, tabs.length) - tabsViewport(innerWidth));
  const to = Math.max(0, Math.min(most, scrolled + event.deltaY + event.deltaX));
  if (to === scrolled) return;
  scrolled = to;
  const width = tabWidth(innerWidth, tabs.length);
  tabs.forEach((tab, index) => tabElements.get(tab.id)?.style.setProperty("transform", "translateX(" + (index * width - scrolled) + "px)"));
  scrolledTo(tabs.length, width);
}, { passive: false });

window.addEventListener("resize", render);
window.addEventListener("dragstart", (event) => event.preventDefault());

// Reports the OS dark state; the host replies with this frame's effective
// dark state, which differs for frames with an explicit appearance.
const darkMode = matchMedia("(prefers-color-scheme: dark)");
const tellDark = () => {
  rpc("strip.dark", darkMode.matches).then((dark) => {
    if (typeof dark === "boolean") document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, () => {});
};
darkMode.addEventListener("change", tellDark);
tellDark();

let heard = false;
listeners.add((name, payload) => {
  if (name === "strip") { heard = true; apply(payload); }
});
const first = await rpc("strip.state");
if (!heard) apply(first);
`;
