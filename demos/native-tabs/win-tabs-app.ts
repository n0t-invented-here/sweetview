// The tabbed app on Windows, minus the event loop: the windows, their tabs,
// and what opening, closing and moving a tab means. app.ts runs it;
// scripts/win-drive.ts runs it and then plays the user. mac-tabs-app.ts is its
// macOS counterpart, where AppKit keeps most of this state itself.
//
// A window is a frame (win-tab-window.ts) with the strip's webview along its
// top. A tab is three things made together and torn down together: a pane in
// the frame, a webview hosted in the pane (createWebviewApp), and this
// module's record of it. Nothing is shared between tabs but the process.
//
// Everything that shows, hides, moves or destroys a webview runs on a turn of
// Bun's loop of its own (`later`), never inside the page call or the WebView2
// event that asked for it: a webview cannot be destroyed from inside its own
// callback, and the menu and the window drag run a loop of their own.

import { createWebviewApp, indexHtml, type WebviewApp } from "@n1h/sweetview";
import { dotIcon, nativeWindow, quitEventLoop, type Icon } from "@n1h/sweetview/native";
import { webviewLibPath } from "../../src/webview-lib";
import pageCss from "./build/frontend/main.css" with { type: "file" };
import pageJs from "./build/frontend/main.js" with { type: "file" };
import stripCss from "./build/frontend/strip.css" with { type: "file" };
import stripJs from "./build/frontend/strip.js" with { type: "file" };
import { tabHue, type Events, type Methods, type TabInfo } from "./shared";
import { STRIP_HEIGHT, dropIndex, type StripEvents, type StripMethods, type StripPoint, type StripState } from "./strip-shared";
import { FOLLOW_TITLE, tabPageBody } from "./tab-page";
import { displayHost, webAddress } from "./web-address";
import { asWindowHandle, createFrameWindow, cursorPosition, leftButtonDown, popupMenu, setDarkWindows, windowMenu, type FrameWindow, type MenuEntry, type Point } from "./win-tab-window";
import { LAST_TAB, shortcutFor, type Shortcut } from "./win-shortcuts";
import { controllerOf, moveFocus, notifyMoved, onAcceleratorKey, onNewWindowRequested, setVisible, type Controller } from "./win-webview2";

export const APP_NAME = "Native Tabs";

export type Tab = {
  number: number;
  title: string;
  /** Set for a tab showing a site; a tab showing this demo's own page has none. */
  address?: string;
  /** Undefined until the webview exists, a few milliseconds after the tab does. */
  app?: WebviewApp<Methods, Events>;
  /** The demo's page is up and listening for events; never true for a site. */
  listening: boolean;
  /** The window the tab is in now. */
  window: TabWindow;
  /** The child window its webview lives in; it goes with the tab from window to window. */
  pane: bigint;
  /** The tab whose page asked for this one. */
  opener?: Tab;
  /** There is something to show: the demo's page has drawn itself, or a site is on its way. */
  ready: boolean;
  closed: boolean;
};

export type TabWindow = {
  readonly frame: FrameWindow;
  /** Left to right. */
  readonly tabs: Tab[];
  selected?: Tab;
  /** Undefined until the strip's webview exists. */
  strip?: WebviewApp<StripMethods, StripEvents>;
  /** On screen: from when the strip and the first tab have both drawn. */
  visible: boolean;
  closed: boolean;
};

export type TabsApp = {
  /** The windows open, the one used last first. */
  readonly windows: readonly TabWindow[];
  /** Open tabs by number, the ones still loading included. */
  readonly open: ReadonlyMap<number, Tab>;
  /**
   * Opens a tab and resolves once there is something in it to show. It goes
   * after the selected tab of `from.window` (default: the window used last),
   * or after `from.opener` and the tabs that tab opened before, and becomes
   * the selected tab. Tabs asked for in a row keep the order they were asked in.
   * Rejects once the last window has closed: the app has ended, and nothing
   * brings it back.
   */
  openTab(address?: string, from?: { opener?: Tab; window?: TabWindow }): Promise<Tab>;
  select(tab: Tab): void;
  close(tab: Tab): void;
  /** Puts a tab at `index` among its window's tabs. */
  move(tab: Tab, index: number): void;
  /** Gives a tab a window of its own, near the one it was in. */
  moveToNewWindow(tab: Tab): Promise<TabWindow>;
  /** Brings every tab into the window used last. */
  mergeAll(): void;
  /** As the window's close button does: closes its tabs, and the window with the last. */
  closeWindow(window: TabWindow): void;
  /** What a key does, by name: what Ctrl+T, Ctrl+W, Ctrl+Tab and the rest run. */
  shortcut(window: TabWindow, shortcut: Shortcut): void;
  /** What a strip is showing: what its page was last sent. */
  stripState(window: TabWindow): StripState;
};

const PAGE_BODY = tabPageBody({
  lede: "This tab is its own <code>WebView2</code> in a child window of its own. The tab strip above is one more webview, where the title bar was.",
  hint: "Also try the <kbd>+</kbd> in the tab strip, <kbd>Ctrl</kbd>+<kbd>T</kbd>, <kbd>Ctrl</kbd>+<kbd>W</kbd> and <kbd>Ctrl</kbd>+<kbd>Tab</kbd>, dragging a tab along the strip, out of the window and back onto a strip, and a right-click on a tab.",
});

// &#xE710; add, &#xE921; minimise, &#xE8BB; close, in Segoe Fluent Icons; the page sets maximise / restore itself.
const STRIP_BODY = `<div id="strip">
<div id="tabs" role="tablist" aria-label="Tabs"></div>
<button id="new" type="button" tabindex="-1" title="New tab (Ctrl+T)" aria-label="New tab">&#xE710;</button>
<div id="caption">
<button id="minimize" type="button" tabindex="-1" title="Minimize" aria-label="Minimize">&#xE921;</button>
<button id="maximize" type="button" tabindex="-1"></button>
<button id="close" type="button" tabindex="-1" title="Close" aria-label="Close">&#xE8BB;</button>
</div>
<div class="edge" data-edge="top"></div><div class="edge" data-edge="top-left"></div><div class="edge" data-edge="top-right"></div>
</div>`;

/** In the taskbar and Alt+Tab; the window has no title bar to show one in. */
const APP_ICON: Icon = { windows: { ico: dotIcon({ color: "#6d5df6", sizes: [16, 24, 32, 48] }) } };
const WIDTH = 1040;
const HEIGHT = 720 + STRIP_HEIGHT; // the page area macOS gives a tab, plus the strip

const failed = (err: unknown) => console.error("native-tabs: could not open a tab:", err instanceof Error ? err.message : err);

/** Runs `work` on a turn of Bun's loop of its own. */
const later = (work: () => void) =>
  void setTimeout(() => {
    try {
      work();
    } catch (err) {
      console.error("native-tabs:", err);
    }
  }, 0);

export async function startTabsApp(): Promise<TabsApp> {
  const libPath = await webviewLibPath();
  const debug = process.env.WEBVIEW_DEBUG === "1";
  const windows: TabWindow[] = [];
  const open = new Map<number, Tab>();
  let opened = 0;
  let ended = false; // the last window closed

  // What only this module needs to know about a tab or a window.
  const controllers = new Map<Tab | TabWindow, Controller>();
  const cleanups = new Map<Tab, (() => void)[]>(); // stops WebView2 calling for a tab that is gone
  const shown = new Map<TabWindow, Tab>(); // the tab whose pane is on show: the selected one, or the one before it until the selected one has drawn
  const stripUp = new Set<TabWindow>(); // its strip's page has asked what to show
  const active = new Set<TabWindow>();
  const scrolledBy = new Map<TabWindow, number>(); // how far its strip's row of tabs is scrolled, as its page last said
  const making = new Map<TabWindow, number>(); // webviews still being made in a window's panes
  const revealed = new Map<TabWindow, PromiseWithResolvers<void>>();
  const settled = new Map<Tab, () => void>(); // resolves openTab

  const stripState = (win: TabWindow): StripState => ({
    tabs: win.tabs.map((tab) => ({ id: tab.number, title: tab.title, ...(tab.address === undefined ? { hue: tabHue(tab.number) } : {}) })),
    selected: win.selected?.number ?? null,
    maximized: win.frame.maximized(),
    active: active.has(win),
  });
  const pushStrip = (win: TabWindow) => {
    if (stripUp.has(win) && !win.closed) win.strip?.emit("strip", stripState(win));
  };
  const announce = () => {
    for (const tab of open.values()) if (tab.listening) tab.app?.emit("tabs", { count: open.size });
  };
  const titleWindow = (win: TabWindow) => win.frame.setTitle(win.selected ? `${win.selected.title} - ${APP_NAME}` : APP_NAME);

  const focusPage = (win: TabWindow) => {
    const controller = controllers.get(shown.get(win) ?? win);
    if (controller !== undefined && !win.closed && win.frame.isForeground()) moveFocus(controller);
  };

  /** Puts the selected tab's pane on show, once it has something to show; until then the tab before it stays. */
  const present = (win: TabWindow) => {
    const tab = win.selected;
    const previous = shown.get(win);
    if (tab === undefined || !tab.ready || previous === tab) return;
    const controller = controllers.get(tab);
    if (controller !== undefined) setVisible(controller, true);
    win.frame.showPane(tab.pane);
    shown.set(win, tab);
    if (previous !== undefined && previous.window === win && !previous.closed) {
      win.frame.hidePane(previous.pane);
      const before = controllers.get(previous);
      if (before !== undefined) setVisible(before, false);
    }
    titleWindow(win);
    focusPage(win);
  };

  /** A page that has drawn and is not the one on show is told it is hidden: WebView2 starts every page off as visible. */
  const hideUnlessShown = (tab: Tab) => {
    const controller = controllers.get(tab);
    if (controller !== undefined && tab.ready && !tab.closed && shown.get(tab.window) !== tab) setVisible(controller, false);
  };

  /** Shows a window for the first time, when its strip and its selected tab have both drawn: it appears whole. */
  const reveal = (win: TabWindow, anyway = false) => {
    if (win.visible || win.closed || win.tabs.length === 0) return;
    if (!anyway && !(stripUp.has(win) && shown.get(win) === win.selected)) return;
    win.visible = true;
    win.frame.show();
    revealed.get(win)?.resolve();
  };

  const ready = (tab: Tab) => {
    if (tab.ready || tab.closed) return;
    tab.ready = true;
    present(tab.window);
    hideUnlessShown(tab);
    reveal(tab.window);
    settled.get(tab)?.();
  };

  const select = (tab: Tab) => {
    const win = tab.window;
    if (tab.closed || win.selected === tab) return;
    win.selected = tab;
    present(win);
    titleWindow(win);
    pushStrip(win);
  };

  const rename = (tab: Tab, title: string) => {
    tab.title = title.trim() || `Tab ${tab.number}`;
    if (tab.window.selected === tab) titleWindow(tab.window);
    pushStrip(tab.window);
  };

  const destroyWindow = (win: TabWindow) => {
    if (win.closed) return;
    win.closed = true;
    windows.splice(windows.indexOf(win), 1);
    controllers.delete(win);
    win.strip?.dispose();
    win.frame.destroy();
    if (windows.length === 0) {
      ended = true; // the last window was the app
      quitEventLoop();
    }
  };

  /** After a tab left a window: the next one is shown, or the window goes. */
  const tabLeft = (win: TabWindow) => {
    if (win.closed) return;
    if (win.tabs.length > 0) {
      present(win);
      titleWindow(win);
      pushStrip(win);
    } else if ((making.get(win) ?? 0) === 0) {
      destroyWindow(win);
    } else {
      win.frame.hide(); // a webview is still being made in one of its panes; openTab destroys the window when that is over
    }
  };

  /** Takes a tab out of its window's list; the tab to its right is selected in its place, else the one to its left. */
  const unlist = (tab: Tab) => {
    const win = tab.window;
    const index = win.tabs.indexOf(tab);
    win.tabs.splice(index, 1);
    if (win.selected === tab) win.selected = win.tabs[index] ?? win.tabs[index - 1];
    return win;
  };

  const destroyTab = (tab: Tab) => {
    for (const stop of cleanups.get(tab) ?? []) stop();
    cleanups.delete(tab);
    controllers.delete(tab);
    tab.app?.dispose();
    tab.window.frame.destroyPane(tab.pane);
  };

  const close = (tab: Tab) => {
    if (tab.closed) return;
    tab.closed = true;
    open.delete(tab.number);
    const win = unlist(tab);
    if (win.tabs.length > 0) present(win); // the next tab's page first, so the page area is never empty in between
    if (shown.get(win) === tab) shown.delete(win);
    win.frame.hidePane(tab.pane);
    if (tab.app) destroyTab(tab); // else its webview is still being made, and openTab destroys it on arrival
    tabLeft(win);
    announce();
    settled.get(tab)?.();
  };

  const closeWindow = (win: TabWindow) => {
    for (const tab of [...win.tabs]) close(tab);
  };

  const move = (tab: Tab, index: number) => {
    const { tabs } = tab.window;
    if (tab.closed) return;
    tabs.splice(tabs.indexOf(tab), 1);
    tabs.splice(Math.max(0, Math.min(tabs.length, index)), 0, tab);
    pushStrip(tab.window);
  };

  /** Moves a tab, pane and page and all, into another window, and selects it there. */
  const moveTab = (tab: Tab, target: TabWindow, index: number) => {
    const source = unlist(tab);
    if (shown.get(source) === tab) shown.delete(source);
    target.frame.adoptPane(tab.pane);
    tab.window = target;
    tab.opener = undefined; // it left the tabs it was opened among
    target.tabs.splice(Math.max(0, Math.min(target.tabs.length, index)), 0, tab);
    target.selected = tab;
    present(target);
    const controller = controllers.get(tab);
    if (controller !== undefined) notifyMoved(controller);
    titleWindow(target);
    pushStrip(target);
    reveal(target);
    tabLeft(source);
  };

  const mergeAll = () => {
    const into = windows[0];
    if (into === undefined) return;
    const keep = into.selected;
    for (const other of windows.filter((win) => win !== into)) for (const tab of [...other.tabs]) moveTab(tab, into, into.tabs.length);
    if (keep) select(keep);
    into.frame.show();
  };

  /** A window of its own for a tab, its top-left corner at `corner`; resolves when the window is on screen. */
  const tearOff = async (tab: Tab, corner: Point): Promise<TabWindow> => {
    const win = await createWindow(corner);
    if (tab.closed) {
      destroyWindow(win);
      throw new Error("the tab closed before its window was ready");
    }
    moveTab(tab, win, 0);
    await revealed.get(win)!.promise;
    return win;
  };

  const moveToNewWindow = (tab: Tab): Promise<TabWindow> => {
    const strip = tab.window.frame.stripRect();
    const step = Math.round(STRIP_HEIGHT * tab.window.frame.scale());
    return tearOff(tab, { x: strip.x + step, y: strip.y + step }); // down and right of the window it leaves, as a new window opens
  };

  /** A window held by its one tab was let go: over another window's strip, the tab joins that window where it was dropped. */
  const dropOnStrip = (win: TabWindow) => {
    const tab = win.tabs[0];
    if (win.closed || tab === undefined || win.tabs.length !== 1) return;
    const at = cursorPosition();
    const target = windows.find((other) => {
      const strip = other.frame.stripRect();
      return other !== win && other.visible && at.x >= strip.x && at.x < strip.x + strip.width && at.y >= strip.y && at.y < strip.y + strip.height;
    });
    if (target === undefined) return;
    const strip = target.frame.stripRect();
    const scale = target.frame.scale();
    moveTab(tab, target, dropIndex(strip.width / scale, target.tabs.length, (at.x - strip.x) / scale, scrolledBy.get(target) ?? 0));
    target.frame.show();
  };

  /** Hands a window to the window manager while the button is down, and looks where it was let go. `held` is where in its strip the pointer has its tab. */
  const dragByTab = (win: TabWindow, held: StripPoint) => {
    const from = win.frame.stripRect();
    win.frame.startDrag(held); // puts the tab under the cursor, and returns when the button comes up
    const to = win.closed ? from : win.frame.stripRect();
    if (to.x !== from.x || to.y !== from.y) dropOnStrip(win); // a press that moved nothing is a click, not a drop
  };

  /** A tab was dragged out of its strip, the button still down. `held` is where the pointer has it, in a strip showing it alone. */
  const detach = async (tab: Tab, held: StripPoint) => {
    if (tab.closed) return;
    if (tab.window.tabs.length === 1) return dragByTab(tab.window, held); // a window's only tab takes the window with it
    const at = cursorPosition();
    const scale = tab.window.frame.scale();
    const win = await tearOff(tab, { x: at.x - Math.round(held.x * scale), y: at.y - Math.round(held.y * scale) }); // its tab under the cursor
    if (leftButtonDown()) dragByTab(win, held); // else it was let go while the window was being made, and the window stays there
  };

  const shortcut = (win: TabWindow, key: Shortcut) => {
    if (win.closed) return;
    const { tabs, selected } = win;
    const step = (by: number) => {
      const next = tabs[(tabs.indexOf(selected!) + by + tabs.length) % tabs.length];
      if (selected && next) select(next);
    };
    if (key === "new") void openTab(undefined, { window: win }).catch(failed);
    else if (key === "close") selected && close(selected);
    else if (key === "next") step(1);
    else if (key === "previous") step(-1);
    else if (key === "closeWindow") closeWindow(win);
    else {
      const tab = key.select === LAST_TAB ? tabs.at(-1) : tabs[key.select];
      if (tab) select(tab);
    }
  };

  /** A right-click in the strip: on a tab, the tab's menu; on the empty part, the window's own menu, as on any title bar. */
  const showMenu = (win: TabWindow, tab: Tab | undefined) => {
    if (tab === undefined) return windowMenu(win.frame.hwnd);
    popupMenu(win.frame.hwnd, [
      { label: "New tab\tCtrl+T", click: () => shortcut(win, "new") },
      "separator",
      { label: "Move tab to new window", enabled: win.tabs.length > 1, click: () => void moveToNewWindow(tab).catch(failed) },
      { label: "Merge all windows", enabled: windows.length > 1, click: mergeAll },
      "separator",
      { label: "Close tab\tCtrl+W", click: () => close(tab) },
      {
        label: "Close other tabs",
        enabled: win.tabs.length > 1,
        click() {
          for (const other of [...win.tabs]) if (other !== tab) close(other);
        },
      },
    ]);
  };

  async function createWindow(at?: Point): Promise<TabWindow> {
    let maximized = false;
    const frame = createFrameWindow({
      title: APP_NAME,
      width: WIDTH,
      height: HEIGHT,
      minWidth: 560,
      minHeight: 420 + STRIP_HEIGHT,
      stripHeight: STRIP_HEIGHT,
      at,
      onCloseRequest: () => later(() => closeWindow(win)),
      onActivate(now) {
        if (now) {
          active.add(win);
          if (windows.includes(win)) windows.unshift(...windows.splice(windows.indexOf(win), 1)); // the window used last comes first
          later(() => focusPage(win)); // the keyboard to the page, wherever in the window the click was
        } else {
          active.delete(win);
        }
        pushStrip(win);
      },
      onResized() {
        if (maximized !== frame.maximized()) pushStrip(win); // the strip draws maximise or restore, and drops its top resize edge
        maximized = frame.maximized();
      },
      onMoved() {
        for (const item of [win, ...win.tabs]) {
          const controller = controllers.get(item);
          if (controller !== undefined) notifyMoved(controller);
        }
      },
    });
    nativeWindow(frame.hwnd).setIcon(APP_ICON);
    const win: TabWindow = { frame, tabs: [], visible: false, closed: false };
    windows.push(win);
    revealed.set(win, Promise.withResolvers());

    const tabOf = (id: number) => win.tabs.find((tab) => tab.number === id);
    // What a call from the strip does, on a turn of its own. The press that led to it gave the strip
    // the keyboard; when the work is over (a menu closed, a drag let go) the page has it back, as
    // a click on a title bar never takes the keyboard from the document.
    const fromStrip = (work: () => void) =>
      later(() => {
        try {
          work();
        } finally {
          focusPage(win);
        }
      });
    try {
      win.strip = await createWebviewApp<StripMethods, StripEvents>({
        title: APP_NAME,
        window: asWindowHandle(frame.stripPane),
        width: Math.round(frame.stripRect().width / frame.scale()),
        height: STRIP_HEIGHT,
        debug,
        assets: { "index.html": indexHtml({ title: APP_NAME, body: STRIP_BODY }), "main.js": stripJs, "main.css": stripCss },
        uiMethods: {
          "strip.state"() {
            stripUp.add(win);
            later(() => reveal(win));
            return stripState(win);
          },
          "strip.select": (id) => fromStrip(() => tabOf(id) && select(tabOf(id)!)),
          "strip.close": (id) => fromStrip(() => tabOf(id) && close(tabOf(id)!)),
          "strip.new": () => fromStrip(() => shortcut(win, "new")),
          "strip.move": ({ id, index }) => fromStrip(() => tabOf(id) && move(tabOf(id)!, index)),
          "strip.detach": ({ id, held }) => fromStrip(() => tabOf(id) && void detach(tabOf(id)!, held).catch(failed)),
          "strip.menu": (id) => fromStrip(() => showMenu(win, id === null ? undefined : tabOf(id))),
          "strip.focus": () => fromStrip(() => {}),
          "strip.scrolled": (by) => void scrolledBy.set(win, by),
          "strip.dark": (dark) => later(() => setDarkWindows(dark)),
          "strip.drag": (held) => fromStrip(() => frame.startDrag(held)),
          "strip.resize": ({ edge, held }) => fromStrip(() => frame.startResize(edge, held)),
          "strip.minimize": () => fromStrip(() => frame.minimize()),
          "strip.maximize": () => fromStrip(() => frame.toggleMaximize()),
          "strip.closeWindow": () => fromStrip(() => closeWindow(win)),
        },
      });
    } catch (err) {
      destroyWindow(win);
      throw err;
    }
    frame.layout(); // the library sized the pane its own way, and its child in it not at all
    const controller = controllerOf(win.strip.webview, libPath);
    controllers.set(win, controller);
    // Every key: the strip has no use for the browser's own (find, zoom, reload, print), and the tabs' keys work from here too.
    onAcceleratorKey(controller, (key) => {
      const found = shortcutFor(key);
      if (found !== undefined) later(() => shortcut(win, found));
      return true;
    });
    setTimeout(() => reveal(win, true), 1500); // a strip that never asks still gets its window shown
    return win;
  }

  let firstWindow: Promise<TabWindow> | undefined;

  async function openTab(address?: string, from: { opener?: Tab; window?: TabWindow } = {}): Promise<Tab> {
    if (ended) throw new Error("native-tabs: the app has ended; its last window was closed");
    const opener = from.opener && !from.opener.closed ? from.opener : undefined;
    const asked = from.window && !from.window.closed ? from.window : undefined;
    // Tabs asked for before there is a window (the launch) share the one being made.
    const win = opener?.window ?? asked ?? windows[0] ?? (await (firstWindow ??= createWindow().finally(() => (firstWindow = undefined))));

    const number = ++opened;
    const tab: Tab = { number, title: address === undefined ? `Tab ${number}` : displayHost(address), address, listening: false, window: win, pane: win.frame.createPane(), opener, ready: false, closed: false };
    // Where it goes is settled now, not when the page has loaded: after the tab that asked and the
    // tabs it asked for before, or after the selected tab. Being selected at once, the next one
    // asked for goes after it: Ctrl+T three times gives three tabs in that order.
    const base = opener ?? win.selected;
    let index = base ? win.tabs.indexOf(base) + 1 : win.tabs.length;
    if (opener) while (win.tabs[index]?.opener === opener) index++;
    win.tabs.splice(index, 0, tab);
    open.set(number, tab);
    win.selected = tab; // its strip says so now; its page takes the place of the one on show once it has drawn
    titleWindow(win);
    pushStrip(win);
    announce();

    const done = Promise.withResolvers<void>();
    settled.set(tab, done.resolve);
    making.set(win, (making.get(win) ?? 0) + 1);
    let app: WebviewApp<Methods, Events> | undefined;
    try {
      app = await createWebviewApp<Methods, Events>({
        title: tab.title,
        window: asWindowHandle(tab.pane),
        ...win.frame.pageSize(),
        debug,
        assets: { "index.html": indexHtml({ title: tab.title, body: PAGE_BODY }), "main.js": pageJs, "main.css": pageCss },
        // A site gets none of these: only this demo's own page may open, rename and close tabs.
        uiMethods:
          address !== undefined
            ? {}
            : {
                "tab.info"(): TabInfo {
                  tab.listening = true;
                  later(() => ready(tab)); // the page has drawn itself: the tab appears already filled in
                  return { number: tab.number, title: tab.title, tabs: open.size };
                },
                "tab.open"(to) {
                  const target = to === null ? undefined : webAddress(to); // an address that is refused is refused here, in the page's own call
                  later(() => void openTab(target, { opener: tab }).catch(failed)); // next to the tab that asked
                },
                "tab.rename": (title) => later(() => rename(tab, title)),
                "tab.close": () => later(() => close(tab)),
              },
      });
    } finally {
      making.set(win, making.get(win)! - 1);
      tab.app = app;
      if (app === undefined && !tab.closed) close(tab); // no webview: the tab goes
      if (tab.closed) destroyTab(tab); // that, or closed while its webview was being made: close() left the pane for us
      if (!win.closed && win.tabs.length === 0 && making.get(win) === 0) destroyWindow(win);
    }
    if (tab.closed) return tab;

    tab.window.frame.placePane(tab.pane); // the library sized the pane its own way, and its child in it not at all
    const controller = controllerOf(app.webview, libPath);
    controllers.set(tab, controller);
    hideUnlessShown(tab);
    cleanups.set(tab, [
      onAcceleratorKey(controller, (key) => {
        const found = shortcutFor(key);
        if (found !== undefined) later(() => shortcut(tab.window, found));
        return found !== undefined; // every other key is the page's, or the browser's (find, reload, zoom)
      }),
      // A link that asks for a new window gets a tab: left alone, WebView2 opens a bare popup.
      onNewWindowRequested(controller, (to) => {
        if (tab.closed) return;
        try {
          void openTab(webAddress(to), { opener: tab }).catch(failed);
        } catch {
          // not an http or https address (about:blank, for a window the page means to script): nothing opens
        }
      }),
    ]);
    // The page can ask who it is before `tab.app` is set, and events cannot reach it until then: tell it now what it missed.
    if (tab.listening) app.emit("tabs", { count: open.size });

    if (address !== undefined) {
      app.webview.bind("__nativeTabsTitle", (title: unknown) => {
        if (typeof title === "string") later(() => rename(tab, title));
      });
      app.webview.init(FOLLOW_TITLE);
      app.webview.navigate(address); // a site that cannot be reached shows the browser's own page saying why
      ready(tab);
    } else {
      setTimeout(() => ready(tab), 1000); // a page that never asks still gets shown
    }
    await done.promise;
    return tab;
  }

  return { windows, open, openTab, select, close, move, moveToNewWindow, mergeAll, closeWindow, shortcut, stripState };
}
