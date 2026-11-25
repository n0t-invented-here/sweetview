// Windows TabsDriver: wires Window({ tabs: true }) (backed by FrameWindow) to
// an embedded tab-strip WebView2 and per-tab WebView2 child panes, supporting
// shortcuts, drag reorder, tear-off, drop-on-strip, context menus, and
// Tab / App tab events.

import { WebView, type Tab, type TabOptions, type TabsDriver } from "../app";
import { indexHtml } from "../html";
import type { EventMap, MethodMap } from "../ipc";
import { WM_CLOSE, user32 } from "../native/win32/api";
import { LAST_TAB, shortcutFor, type Shortcut } from "../native/win32/shortcuts";
import { STRIP_HEIGHT, dropIndex, type StripEvents, type StripMethods, type StripPoint, type StripState } from "../native/win32/strip-shared";
import {
  cursorPosition,
  getTabFrame,
  leftButtonDown,
  setDarkWindows,
  showTabPopupMenu,
  windowMenu,
  type FrameWindow,
} from "../native/win32/tab-window";
import { asHwnd } from "../native/win32/window";
import { Window, emitWindowNewTab, emitWindowTabClose, emitWindowTabSelect, forwardWindowTabEvents, getWindowMeta } from "../native/window";
import { webviewLibPath } from "../webview-lib";
import { STRIP_BODY, STRIP_CSS, STRIP_JS } from "./win-strip-assets";
import { controllerOf, moveFocus, notifyMoved, onAcceleratorKey, onNewWindowRequested, setVisible, type Controller } from "./win-webview2";

const FOLLOW_TITLE = `(() => {
  const report = () => {
    const title = document.title.trim();
    if (title && typeof window.__sweetviewTabTitle === "function") window.__sweetviewTabTitle(title);
  };
  const watch = () => {
    report();
    const head = document.head;
    if (head) new MutationObserver(report).observe(head, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
  addEventListener("load", report);
})();`;

const later = (work: () => void) =>
  void setTimeout(() => {
    try {
      work();
    } catch (err) {
      console.error("sweetview: tab action threw:", err);
    }
  }, 0);

type WinTabRecord = {
  readonly id: number;
  title: string;
  window: WinTabHost;
  pane: bigint;
  webview: WebView<any, any>;
  controller: Controller;
  cleanups: (() => void)[];
  closed: boolean;
  api: Tab<any, any>;
};

type WinTabHost = {
  readonly window: Window;
  readonly frame: FrameWindow;
  readonly tabs: WinTabRecord[];
  selected?: WinTabRecord;
  shown?: WinTabRecord;
  strip?: WebView<StripMethods, StripEvents>;
  stripController?: Controller;
  stripUp: boolean;
  active: boolean;
  scrolledBy: number;
  closed: boolean;
  baseTitle: string;
  stripReady: Promise<void>;
};

const hosts = new Map<Window, WinTabHost>();
const hostOrder: WinTabHost[] = [];
const tabRecordByApi = new WeakMap<object, WinTabRecord>();
let nextTabId = 1;
let cachedLibPath: string | undefined;

async function libPath(): Promise<string> {
  return (cachedLibPath ??= await webviewLibPath());
}

function stripState(host: WinTabHost): StripState {
  return {
    tabs: host.tabs.map((t) => ({ id: t.id, title: t.title })),
    selected: host.selected?.id ?? null,
    maximized: host.frame.isMaximized(),
    active: host.active,
  };
}

function pushStrip(host: WinTabHost): void {
  if (host.stripUp && !host.closed) {
    host.strip?.emit("strip", stripState(host));
  }
}

function syncWindowTitle(host: WinTabHost): void {
  const title = host.selected ? (host.baseTitle ? `${host.selected.title} - ${host.baseTitle}` : host.selected.title) : host.baseTitle;
  host.frame.setTitle(title);
}

function focusPage(host: WinTabHost): void {
  if (host.closed || !host.frame.isForeground()) return;
  const ctrl = host.shown?.controller ?? host.stripController;
  if (ctrl !== undefined) moveFocus(ctrl);
}

function present(host: WinTabHost): void {
  const tab = host.selected;
  const previous = host.shown;
  if (!tab || tab.closed || previous === tab) return;
  setVisible(tab.controller, true);
  host.frame.showPane(tab.pane);
  host.shown = tab;
  if (previous && previous.window === host && !previous.closed) {
    host.frame.hidePane(previous.pane);
    setVisible(previous.controller, false);
  }
  syncWindowTitle(host);
  focusPage(host);
}

function selectTab(record: WinTabRecord): void {
  const host = record.window;
  if (record.closed || host.selected === record) return;
  host.selected = record;
  present(host);
  pushStrip(host);
  emitWindowTabSelect(host.window, record.api);
}

function renameTab(record: WinTabRecord, title: string): void {
  if (record.closed) return;
  record.title = title.trim() || `Tab ${record.id}`;
  if (record.window.selected === record) syncWindowTitle(record.window);
  pushStrip(record.window);
}

function unlistTab(record: WinTabRecord): WinTabHost {
  const host = record.window;
  const index = host.tabs.indexOf(record);
  if (index !== -1) host.tabs.splice(index, 1);
  if (host.selected === record) {
    host.selected = host.tabs[index] ?? host.tabs[index - 1];
  }
  return host;
}

function closeTab(record: WinTabRecord): void {
  if (record.closed) return;
  record.closed = true;
  const host = unlistTab(record);
  if (host.tabs.length > 0) present(host);
  if (host.shown === record) host.shown = undefined;
  host.frame.hidePane(record.pane);
  for (const stop of record.cleanups) stop();
  record.cleanups.length = 0;
  record.webview.dispose();
  host.frame.destroyPane(record.pane);
  syncWindowTitle(host);
  pushStrip(host);
  emitWindowTabClose(host.window, record.api);
  if (host.selected) emitWindowTabSelect(host.window, host.selected.api);
  if (host.tabs.length === 0) {
    // Notify the window's onClose listeners (or default dispose when none are registered).
    user32.SendMessageW(host.frame.hwnd, WM_CLOSE, 0n, 0n);
    if (!host.closed && user32.IsWindow(host.frame.hwnd) === 0) disposeHost(host);
  }
}

function moveTabOrder(record: WinTabRecord, index: number): void {
  if (record.closed) return;
  const { tabs } = record.window;
  const from = tabs.indexOf(record);
  if (from === -1) return;
  tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, index)), 0, record);
  pushStrip(record.window);
}

function moveTabBetweenHosts(record: WinTabRecord, target: WinTabHost, index: number): void {
  const source = unlistTab(record);
  if (source.shown === record) source.shown = undefined;
  target.frame.adoptPane(record.pane);
  record.window = target;
  target.tabs.splice(Math.max(0, Math.min(target.tabs.length, index)), 0, record);
  target.selected = record;
  present(target);
  notifyMoved(record.controller);
  syncWindowTitle(target);
  pushStrip(target);
  emitWindowTabSelect(target.window, record.api);

  if (source.tabs.length > 0) {
    present(source);
    syncWindowTitle(source);
    pushStrip(source);
    if (source.selected) emitWindowTabSelect(source.window, source.selected.api);
  } else {
    disposeHost(source);
  }
}

async function createTearOffHost(from: WinTabHost, bounds?: { x: number; y: number; width: number; height: number }): Promise<WinTabHost> {
  const meta = getWindowMeta(from.window);
  const srcBounds = from.window.bounds();
  const step = Math.round(STRIP_HEIGHT * from.frame.scale());
  const nextWin = new Window({
    title: meta.title,
    tabs: true,
    appearance: meta.appearance,
    icon: meta.icon,
    minWidth: meta.minWidth,
    minHeight: meta.minHeight,
    bounds: bounds ?? {
      x: srcBounds.x + step,
      y: srcBounds.y + step,
      width: srcBounds.width,
      height: srcBounds.height,
    },
  });
  forwardWindowTabEvents(nextWin, from.window);
  return await ensureHost(nextWin);
}

async function moveRecordToNewWindow(record: WinTabRecord, at?: { x: number; y: number }): Promise<Window> {
  if (record.closed) throw new Error("sweetview: cannot move a closed tab to a new window");
  const src = record.window;
  const srcBounds = src.window.bounds();
  const target = await createTearOffHost(
    src,
    at ? { x: at.x, y: at.y, width: srcBounds.width, height: srcBounds.height } : undefined,
  );
  if (record.closed) {
    disposeHost(target);
    throw new Error("sweetview: the tab closed before its new window was ready");
  }
  moveTabBetweenHosts(record, target, 0);
  target.window.show();
  return target.window;
}

function dropOnStrip(host: WinTabHost): void {
  const record = host.tabs[0];
  if (host.closed || !record || host.tabs.length !== 1) return;
  const at = cursorPosition();
  const target = hostOrder.find((other) => {
    if (other === host || other.closed || !other.frame.isVisible()) return false;
    const strip = other.frame.stripRect();
    return at.x >= strip.x && at.x < strip.x + strip.width && at.y >= strip.y && at.y < strip.y + strip.height;
  });
  if (!target) return;
  const strip = target.frame.stripRect();
  const scale = target.frame.scale();
  const idx = dropIndex(strip.width / scale, target.tabs.length, (at.x - strip.x) / scale, target.scrolledBy);
  moveTabBetweenHosts(record, target, idx);
  target.frame.show();
}

function dragByTab(host: WinTabHost, held: StripPoint): void {
  const from = host.frame.stripRect();
  host.frame.startDrag(held);
  const to = host.closed ? from : host.frame.stripRect();
  if (to.x !== from.x || to.y !== from.y) dropOnStrip(host);
}

async function detachTab(record: WinTabRecord, held: StripPoint): Promise<void> {
  if (record.closed) return;
  if (record.window.tabs.length === 1) {
    dragByTab(record.window, held);
    return;
  }
  const at = cursorPosition();
  const scale = record.window.frame.scale();
  const win = await moveRecordToNewWindow(record, {
    x: at.x - Math.round(held.x * scale),
    y: at.y - Math.round(held.y * scale),
  });
  const newHost = hosts.get(win);
  if (newHost && leftButtonDown()) dragByTab(newHost, held);
}

function handleShortcut(host: WinTabHost, key: Shortcut): void {
  if (host.closed) return;
  const { tabs, selected } = host;
  const step = (by: number) => {
    if (!selected || tabs.length === 0) return;
    const next = tabs[(tabs.indexOf(selected) + by + tabs.length) % tabs.length];
    if (next) selectTab(next);
  };
  if (key === "new") emitWindowNewTab(host.window);
  else if (key === "close") selected && closeTab(selected);
  else if (key === "next") step(1);
  else if (key === "previous") step(-1);
  else if (key === "closeWindow") {
    for (const tab of [...tabs]) closeTab(tab);
  } else {
    const tab = key.select === LAST_TAB ? tabs.at(-1) : tabs[key.select];
    if (tab) selectTab(tab);
  }
}

function showContextMenu(host: WinTabHost, record: WinTabRecord | undefined): void {
  if (!record) {
    windowMenu(host.frame.hwnd);
    return;
  }
  showTabPopupMenu(host.frame.hwnd, [
    { label: "New tab\tCtrl+T", click: () => emitWindowNewTab(host.window) },
    { type: "separator" },
    { label: "Move tab to new window", enabled: host.tabs.length > 1, click: () => void moveRecordToNewWindow(record).catch(console.error) },
    { label: "Merge all windows", enabled: hostOrder.length > 1, click: () => mergeAllWindows() },
    { type: "separator" },
    { label: "Close tab\tCtrl+W", click: () => closeTab(record) },
    {
      label: "Close other tabs",
      enabled: host.tabs.length > 1,
      click() {
        for (const other of [...host.tabs]) if (other !== record) closeTab(other);
      },
    },
  ]);
}

function disposeHost(host: WinTabHost): void {
  if (host.closed) return;
  host.closed = true;
  hosts.delete(host.window);
  const idx = hostOrder.indexOf(host);
  if (idx !== -1) hostOrder.splice(idx, 1);
  for (const tab of [...host.tabs]) {
    if (!tab.closed) {
      tab.closed = true;
      for (const stop of tab.cleanups) stop();
      tab.cleanups.length = 0;
      tab.webview.dispose();
      host.frame.destroyPane(tab.pane);
    }
  }
  host.tabs.length = 0;
  host.strip?.dispose();
  host.window.dispose();
}

async function ensureHost(window: Window): Promise<WinTabHost> {
  const existing = hosts.get(window);
  if (existing) {
    await existing.stripReady;
    return existing;
  }
  const meta = getWindowMeta(window);
  if (!meta.tabs) {
    throw new Error("sweetview: WebView.openTab requires a Window created with { tabs: true }");
  }
  const hwnd = asHwnd(window.handle);
  const frame = getTabFrame(hwnd);
  if (!frame) {
    throw new Error("sweetview: tabbed window frame not found");
  }

  let resolveStrip!: () => void;
  const stripReady = new Promise<void>((r) => (resolveStrip = r));

  const host: WinTabHost = {
    window,
    frame,
    tabs: [],
    stripUp: false,
    active: frame.isForeground(),
    scrolledBy: 0,
    closed: false,
    baseTitle: meta.title,
    stripReady,
  };
  hosts.set(window, host);
  hostOrder.unshift(host);

  let maximized = frame.isMaximized();
  frame.addCallbacks({
    onActivate(now) {
      host.active = now;
      if (now) {
        const i = hostOrder.indexOf(host);
        if (i > 0) hostOrder.unshift(...hostOrder.splice(i, 1));
        later(() => focusPage(host));
      }
      pushStrip(host);
    },
    onResized() {
      const nextMax = frame.isMaximized();
      if (maximized !== nextMax) {
        maximized = nextMax;
        pushStrip(host);
      }
    },
    onMoved() {
      if (host.stripController) notifyMoved(host.stripController);
      for (const t of host.tabs) notifyMoved(t.controller);
    },
  });

  const tabOf = (id: number) => host.tabs.find((t) => t.id === id);
  const fromStrip = (work: () => void) =>
    later(() => {
      try {
        work();
      } finally {
        focusPage(host);
      }
    });

  const stripWin = Window.fromHandle(frame.stripPane);
  const lp = await libPath();
  host.strip = await WebView.attach<StripMethods, StripEvents>(stripWin, {
    title: meta.title || "Tabs",
    assets: {
      "index.html": indexHtml({ title: meta.title || "Tabs", body: STRIP_BODY }),
      "main.js": new TextEncoder().encode(STRIP_JS),
      "main.css": new TextEncoder().encode(STRIP_CSS),
    },
    uiMethods: {
      "strip.state"() {
        host.stripUp = true;
        return stripState(host);
      },
      "strip.select": (id) => fromStrip(() => tabOf(id) && selectTab(tabOf(id)!)),
      "strip.close": (id) => fromStrip(() => tabOf(id) && closeTab(tabOf(id)!)),
      "strip.new": () => fromStrip(() => emitWindowNewTab(host.window)),
      "strip.move": ({ id, index }) => fromStrip(() => tabOf(id) && moveTabOrder(tabOf(id)!, index)),
      "strip.detach": ({ id, held }) => fromStrip(() => tabOf(id) && void detachTab(tabOf(id)!, held).catch(console.error)),
      "strip.menu": (id) => fromStrip(() => showContextMenu(host, id === null ? undefined : tabOf(id))),
      "strip.focus": () => fromStrip(() => {}),
      "strip.scrolled": (by) => void (host.scrolledBy = by),
      "strip.dark": (d) => later(() => setDarkWindows(d)),
      "strip.drag": (held) => fromStrip(() => frame.startDrag(held)),
      "strip.resize": ({ edge, held }) => fromStrip(() => frame.startResize(edge, held)),
      "strip.minimize": () => fromStrip(() => frame.minimize()),
      "strip.maximize": () => fromStrip(() => frame.toggleMaximize()),
      "strip.closeWindow": () => fromStrip(() => {
        user32.SendMessageW(host.frame.hwnd, WM_CLOSE, 0n, 0n);
      }),
    },
  });

  frame.layout();
  host.stripController = controllerOf(host.strip.raw, lp);
  onAcceleratorKey(host.stripController, (key) => {
    const found = shortcutFor(key);
    if (found !== undefined) later(() => handleShortcut(host, found));
    return true;
  });

  resolveStrip();
  return host;
}

export function mergeAllWindows(intoWindow?: Window): void {
  const into = (intoWindow ? hosts.get(intoWindow) : undefined) ?? hostOrder[0];
  if (!into) return;
  const keep = into.selected;
  for (const other of hostOrder.filter((h) => h !== into)) {
    for (const tab of [...other.tabs]) moveTabBetweenHosts(tab, into, into.tabs.length);
  }
  if (keep) selectTab(keep);
  into.frame.show();
}

export const winTabsDriver: TabsDriver = {
  async openTab<M extends MethodMap, E extends EventMap>(window: Window, options: TabOptions<M>): Promise<Tab<M, E>> {
    const host = await ensureHost(window);
    if (host.closed) throw new Error("sweetview: cannot open tab in a closed window");

    const id = nextTabId++;
    const initialTitle = options.title ?? (options.url ? new URL(options.url).hostname || options.url : `Tab ${id}`);
    const pane = host.frame.createPane();
    const paneWin = Window.fromHandle(pane);
    const lp = await libPath();

    let webview: WebView<M, E>;
    try {
      webview = await WebView.attach<M, E>(paneWin, { ...options, title: initialTitle });
    } catch (err) {
      host.frame.destroyPane(pane);
      throw err;
    }

    host.frame.placePane(pane);
    const controller = controllerOf(webview.raw, lp);

    const afterRec = options.after ? tabRecordByApi.get(options.after) : undefined;
    const base = afterRec && afterRec.window === host ? afterRec : host.selected;
    const insertAt = base ? host.tabs.indexOf(base) + 1 : host.tabs.length;

    const record: WinTabRecord = {
      id,
      title: initialTitle,
      window: host,
      pane,
      webview,
      controller,
      cleanups: [],
      closed: false,
      api: null as unknown as Tab<M, E>,
    };

    const api: Tab<M, E> = {
      webview,
      get window() {
        return record.window.window;
      },
      get title() {
        return record.title;
      },
      setTitle(title: string) {
        renameTab(record, title);
      },
      select() {
        selectTab(record);
      },
      close() {
        later(() => closeTab(record));
      },
      moveToNewWindow() {
        return moveRecordToNewWindow(record);
      },
      dispose() {
        closeTab(record);
      },
    };
    record.api = api;
    tabRecordByApi.set(api, record);

    record.cleanups.push(
      onAcceleratorKey(controller, (key) => {
        const found = shortcutFor(key);
        if (found !== undefined) later(() => handleShortcut(record.window, found));
        return found !== undefined;
      }),
      onNewWindowRequested(controller, (url) => {
        if (record.closed) return;
        if (/^https?:\/\//i.test(url)) {
          void winTabsDriver.openTab(record.window.window, { url, after: api }).catch(console.error);
        }
      }),
    );

    if (options.url) {
      webview.raw.bind("__sweetviewTabTitle", (t: unknown) => {
        if (typeof t === "string") later(() => renameTab(record, t));
      });
      webview.raw.init(FOLLOW_TITLE);
    }

    host.tabs.splice(insertAt, 0, record);
    host.selected = record;
    present(host);
    pushStrip(host);
    emitWindowTabSelect(host.window, api);
    return api;
  },

  mergeAllWindows,

  disposeWindow(window: Window): void {
    const host = hosts.get(window);
    if (host) disposeHost(host);
  },
};
