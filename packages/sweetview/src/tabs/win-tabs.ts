// Windows TabsDriver: wires Window({ tabs: true }) (its frame's tab side is a
// FrameWindow) to a tab-strip webview and one webview per tab, each a child
// of the frame: the strip across the top, the selected tab over the page area
// and the rest hidden. Shortcuts, drag reorder, tear-off (the tab's webview is
// moved to another frame, not reloaded), drop-on-strip, context menus, and
// Tab / App tab events.

import { WebView, tabAttachHooks, type Tab, type TabAttachHooks, type TabOptions, type TabsDriver, type WebViewOptions } from "../app";
import { indexHtml } from "../html";
import type { EventMap, MethodMap } from "@n1h/sweetview-ipc";
import { LAST_TAB, shortcutFor, type Key, type Shortcut } from "@n1h/sweetview-native/win32/shortcuts";
import { STRIP_HEIGHT, dropIndex, type StripEvents, type StripMethods, type StripPoint, type StripState } from "@n1h/sweetview-native/win32/strip-shared";
import {
  cursorPosition,
  getTabFrame,
  leftButtonDown,
  showTabPopupMenu,
  windowExists,
  windowMenu,
  type FrameWindow,
} from "@n1h/sweetview-native/win32/tab-window";
import { asHwnd } from "@n1h/sweetview-native/win32/window";
import { Window } from "@n1h/sweetview-native";
import {
  emitWindowNewTab,
  emitWindowTabClose,
  emitWindowTabSelect,
  forwardWindowTabEvents,
  getWindowMeta,
  holdWindowNativeDispose,
  isWindowDisposed,
  onWindowDispose,
} from "@n1h/sweetview-native/internal";
import { STRIP_BODY, STRIP_CSS, STRIP_JS } from "./win-strip-assets";
import { loadFailedPage } from "./load-failed";
import { controllerOf, moveFocus, notifyMoved, onAcceleratorKey, onNavigationFailed, onNewWindowRequested, setVisible, type Controller } from "./win-webview2";
import type { RawWebview } from "@n1h/sweetview-native";

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

/**
 * Native-handler removers for one webview. Each is added as soon as its
 * handler is registered, so a later registration that throws never strands
 * an earlier one; `run()` removes them all once (they must go before the
 * webview is destroyed).
 */
function cleanupList() {
  const list: (() => void)[] = [];
  return {
    add(stop: () => void) {
      list.push(stop);
    },
    run() {
      for (const stop of list.splice(0)) {
        try {
          stop();
        } catch (err) {
          console.error("sweetview: removing a WebView2 handler threw:", err);
        }
      }
    },
  };
}
type Cleanups = ReturnType<typeof cleanupList>;

type WinTabRecord = {
  readonly id: number;
  title: string;
  window: WinTabHost;
  webview: WebView<any, any>;
  /** The borrowed `Window.fromHandle(frame)` of the frame the tab opened in, which the webview was attached to; disposed right after `webview`. */
  readonly wrappedWin: Window;
  /** Attach hooks; `rebindFileDrop` moves webview file-drop delivery to the current `window.window`. */
  readonly hooks: TabAttachHooks;
  /** Cleared once the tab closes, before its webview is destroyed, so nothing reaches a released controller. */
  controller?: Controller;
  readonly cleanups: Cleanups;
  closed: boolean;
  api: Tab<any, any>;
  /** The accelerator-key handler registered on the tab's webview. */
  readonly onKey: (key: Key) => boolean;
};

type WinTabHost = {
  readonly window: Window;
  readonly frame: FrameWindow;
  readonly tabs: WinTabRecord[];
  selected?: WinTabRecord;
  shown?: WinTabRecord;
  strip?: WebView<StripMethods, StripEvents>;
  /** The borrowed `Window.fromHandle(frame)` the strip is attached to; disposed right after `strip`. */
  stripWin?: Window;
  stripController?: Controller;
  /** The strip's WebView2 handler removers (its accelerator keys). */
  readonly stripCleanups: Cleanups;
  /** The accelerator-key handler registered on the strip's webview. */
  onStripKey?: (key: Key) => boolean;
  stripUp: boolean;
  active: boolean;
  scrolledBy: number;
  closed: boolean;
  baseTitle: string;
  stripReady: Promise<void>;
  /** Removes the frame callbacks (activate, resize, move); disposeHost runs it before any webview goes. */
  stopFrameCallbacks?: () => void;
};

const hosts = new Map<Window, WinTabHost>();
const hostOrder: WinTabHost[] = [];
const tabRecordByApi = new WeakMap<object, WinTabRecord>();
let nextTabId = 1;
/** Test hook (`_debugWinTabs.failNextStrip`): the next strip attach fails after it loaded, as a failed attach does. */
let failNextStrip = false;

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

/** Places the strip across the top of the frame and the tab on show over the page area. */
function layout(host: WinTabHost): void {
  if (host.closed) return;
  host.stripController?.setBounds(host.frame.stripBounds());
  const shown = host.shown;
  if (shown?.controller && shown.window === host) shown.controller.setBounds(host.frame.pageRect());
}

function hideTab(record: WinTabRecord): void {
  if (record.controller && !record.controller.destroyed) setVisible(record.controller, false);
}

function present(host: WinTabHost): void {
  const tab = host.selected;
  const previous = host.shown;
  if (!tab || tab.closed || previous === tab) return;
  if (tab.controller) {
    tab.controller.setBounds(host.frame.pageRect());
    setVisible(tab.controller, true);
  }
  host.shown = tab;
  if (previous && previous.window === host && !previous.closed) hideTab(previous);
  syncWindowTitle(host);
  focusPage(host);
}

/**
 * Asks the window to close, as its close button does: its onClose listeners
 * run, or it is disposed when there are none (disposeHost then takes its tabs).
 */
function requestClose(host: WinTabHost): void {
  host.frame.requestClose();
  if (!host.closed && !windowExists(host.frame.hwnd)) disposeHost(host);
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

/**
 * Closes a tab. Closing the last tab is a request to close the window (tab close button,
 * Ctrl+W, `tab.close()`): the window's onClose listeners are asked first, as on macOS, and
 * when one intercepts it (closeToTrayOnLastWindow hiding the window, say) the tab stays.
 * `force` (`tab.dispose()`) tears the tab down regardless.
 */
function closeTab(record: WinTabRecord, force = false): void {
  if (record.closed) return;
  const owner = record.window;
  if (!force && !owner.closed && owner.tabs.length === 1 && owner.tabs[0] === record) {
    // A close request runs the onClose listeners, or disposes the window when there are none;
    // disposeHost then takes the tab down with the window and reports it closed (it has to:
    // by the time the request returns, Window.dispose() has cleared the tabClose listeners).
    requestClose(owner);
    return;
  }
  record.closed = true;
  const host = unlistTab(record);
  if (host.tabs.length > 0) present(host);
  if (host.shown === record) host.shown = undefined;
  hideTab(record);
  record.controller = undefined;
  record.cleanups.run();
  record.webview.dispose();
  record.wrappedWin.dispose();
  syncWindowTitle(host);
  pushStrip(host);
  emitWindowTabClose(host.window, record.api);
  if (host.selected) emitWindowTabSelect(host.window, host.selected.api);
  // Notify the window's onClose listeners (or default dispose when none are registered).
  if (host.tabs.length === 0) requestClose(host);
}

/**
 * A tab whose webview was disposed directly (`tab.webview.dispose()`), called from its
 * beforeDestroy hook right before the webview is destroyed: the record is closed, its
 * controller forgotten and the record unlisted now; the selection and the strip are
 * settled afterwards, outside the webview's teardown, unless the host is gone by then.
 */
function releaseDisposedTab(record: WinTabRecord): void {
  if (record.closed) return;
  record.closed = true;
  if (!record.window.closed) hideTab(record);
  record.controller = undefined;
  const host = unlistTab(record);
  if (host.shown === record) host.shown = undefined;
  later(() => {
    record.wrappedWin.dispose();
    if (host.closed) return;
    if (host.tabs.length > 0) present(host);
    syncWindowTitle(host);
    pushStrip(host);
    emitWindowTabClose(host.window, record.api);
    if (host.selected) emitWindowTabSelect(host.window, host.selected.api);
    if (host.tabs.length === 0) requestClose(host);
  });
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
  // The tab's webview moves to the target's frame as it is: its page is not reloaded.
  if (record.controller) {
    hideTab(record);
    record.controller.reparent(target.frame.hwnd);
  }
  if (target.shown === record) target.shown = undefined;
  record.window = target;
  // Drops over the tab's webview now go to the target window only.
  record.hooks.rebindFileDrop?.();
  target.tabs.splice(Math.max(0, Math.min(target.tabs.length, index)), 0, record);
  target.selected = record;
  present(target);
  if (record.controller) notifyMoved(record.controller);
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
    resizable: meta.resizable,
    topmost: meta.topmost,
    opacity: meta.opacity,
    hideFromTaskbar: meta.hideFromTaskbar,
    noActivate: meta.noActivate,
    minWidth: meta.minWidth,
    minHeight: meta.minHeight,
    bounds: bounds ?? {
      x: srcBounds.x + step,
      y: srcBounds.y + step,
      width: srcBounds.width,
      height: srcBounds.height,
    },
  });
  try {
    forwardWindowTabEvents(nextWin, from.window);
    return await ensureHost(nextWin);
  } catch (err) {
    // The tear-off window never got a working host: do not leak its frame.
    nextWin.dispose();
    throw err;
  }
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
  // Destroying a webview pumps messages (discardQuit): no frame callback may walk the tabs,
  // and no tab may be found in host.tabs, while their controllers are being released.
  host.stopFrameCallbacks?.();
  host.stopFrameCallbacks = undefined;
  const tabs = host.tabs.splice(0);
  host.selected = undefined;
  host.shown = undefined;
  for (const tab of tabs) {
    if (!tab.closed) {
      tab.closed = true;
      tab.controller = undefined;
      tab.cleanups.run();
      tab.webview.dispose();
      tab.wrappedWin.dispose();
      // A tab that goes with its window is reported closed, as a tab closed on its own is.
      // This runs as the window's dispose hook, before Window.dispose() clears its tabClose
      // listeners; tab.closed (set above) keeps closeTab from reporting it a second time.
      emitWindowTabClose(host.window, tab.api);
    }
  }
  // Every webview goes before the frame: host.window.dispose() (or the Window.dispose()
  // that ran this as its dispose hook) destroys the frame afterwards.
  host.stripCleanups.run();
  host.strip?.dispose();
  host.strip = undefined;
  host.stripWin?.dispose();
  host.stripWin = undefined;
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
  if (isWindowDisposed(window)) {
    throw new Error("sweetview: cannot open tab in a disposed window");
  }
  const hwnd = asHwnd(window.handle);
  const frame = getTabFrame(hwnd);
  if (!frame) {
    throw new Error("sweetview: tabbed window frame not found");
  }

  let resolveStrip!: () => void;
  let rejectStrip!: (err: unknown) => void;
  const stripReady = new Promise<void>((resolve, reject) => {
    resolveStrip = resolve;
    rejectStrip = reject;
  });
  // Concurrent openTab calls await stripReady; this caller gets the error directly.
  stripReady.catch(() => {});

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
    stripCleanups: cleanupList(),
  };
  hosts.set(window, host);
  hostOrder.unshift(host);
  const stopDisposeHook = onWindowDispose(window, () => disposeHost(host));

  let maximized = frame.isMaximized();
  // Removed again if the strip setup fails, so a retry never stacks callbacks on the frame.
  const stopFrameCallbacks = frame.addCallbacks({
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
      layout(host);
      const nextMax = frame.isMaximized();
      if (maximized !== nextMax) {
        maximized = nextMax;
        pushStrip(host);
      }
    },
    onMoved() {
      if (host.closed) return;
      if (host.stripController) notifyMoved(host.stripController);
      for (const t of host.tabs) if (t.controller) notifyMoved(t.controller);
    },
  });
  host.stopFrameCallbacks = stopFrameCallbacks;

  const tabOf = (id: number) => host.tabs.find((t) => t.id === id);
  const fromStrip = (work: () => void) =>
    later(() => {
      if (host.closed) return;
      try {
        work();
      } finally {
        focusPage(host);
      }
    });

  // Frames with an explicit appearance start the strip in it; "system" frames follow the OS media query.
  const explicitTheme = frame.appearance() === "system" ? "" : `<script>document.documentElement.dataset.theme = "${frame.isDark() ? "dark" : "light"}";</script>`;
  const stripWin = Window.fromHandle(frame.hwnd);
  // Until the strip is attached or rolled back, a window disposal must not destroy the
  // frame under WebView2 initialization: it waits for this release.
  const releaseFrameDispose = holdWindowNativeDispose(window);
  try {
    const stripOptions: WebViewOptions<StripMethods> & { [tabAttachHooks]: TabAttachHooks } = {
      title: meta.title || "Tabs",
      assets: {
        "index.html": indexHtml({ title: meta.title || "Tabs", head: explicitTheme, body: STRIP_BODY }),
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
        // Replies with this frame's effective dark state; explicit appearances ignore the OS.
        "strip.dark": (d) => {
          later(() => {
            if (!host.closed) frame.setSystemDark(d);
          });
          return frame.appearance() === "system" ? d : frame.isDark();
        },
        "strip.drag": (held) => fromStrip(() => frame.startDrag(held)),
        "strip.resize": ({ edge, held }) => fromStrip(() => frame.startResize(edge, held)),
        "strip.minimize": () => fromStrip(() => frame.minimize()),
        "strip.maximize": () => fromStrip(() => frame.toggleMaximize()),
        "strip.closeWindow": () => fromStrip(() => requestClose(host)),
      },
      [tabAttachHooks]: {
        fileDropHost: () => host.window,
        mountChild: () => ({ window: frame.hwnd, bounds: frame.stripBounds(), visible: true }),
        // A disposed window abandons the attach before it touches the frame again.
        isCancelled: () => host.closed,
        beforeNavigate: (raw) => {
          host.stripController = controllerOf(raw);
          host.onStripKey = (key) => {
            const found = shortcutFor(key);
            if (found !== undefined) later(() => handleShortcut(host, found));
            return true;
          };
          host.stripCleanups.add(onAcceleratorKey(host.stripController, host.onStripKey));
        },
        beforeDestroy: () => host.stripCleanups.run(),
      },
    };
    const strip = await WebView.attach<StripMethods, StripEvents>(stripWin, stripOptions);
    if (host.closed || isWindowDisposed(window)) {
      strip.dispose();
      throw new Error("sweetview: the window was disposed while its tab strip was loading");
    }
    if (failNextStrip) {
      failNextStrip = false;
      strip.dispose();
      throw new Error("sweetview: the tab strip failed (a test asked for it)");
    }
    host.strip = strip;
    host.stripWin = stripWin;

    layout(host);
  } catch (err) {
    // Forget the half-built host so a later openTab retries instead of awaiting a strip that never comes.
    rejectStrip(err);
    stopDisposeHook();
    stopFrameCallbacks();
    host.stopFrameCallbacks = undefined;
    host.closed = true;
    if (hosts.get(window) === host) hosts.delete(window);
    const at = hostOrder.indexOf(host);
    if (at !== -1) hostOrder.splice(at, 1);
    host.strip?.dispose();
    host.strip = undefined;
    host.stripWin = undefined;
    host.stripController = undefined;
    stripWin.dispose();
    throw err;
  } finally {
    releaseFrameDispose();
  }

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

/**
 * Test hooks: the strip webview of a tabbed window; an accelerator key
 * handed to the handler a tab's (or, without a tab, the strip's) webview has
 * registered, as WebView2 hands it one (returns whether the key was taken);
 * and a failure of the next strip attach, after its webview loaded.
 */
export const _debugWinTabs = {
  failNextStrip(): void {
    failNextStrip = true;
  },
  strip: (window: Window): WebView<StripMethods, StripEvents> | undefined => hosts.get(window)?.strip,
  pressKey(window: Window, key: Key, tab?: Tab<any, any>): boolean | undefined {
    if (tab !== undefined) return tabRecordByApi.get(tab)?.onKey(key);
    return hosts.get(window)?.onStripKey?.(key);
  },
};

export const winTabsDriver: TabsDriver = {
  async openTab<M extends MethodMap, E extends EventMap>(window: Window, options: TabOptions<M>): Promise<Tab<M, E>> {
    const host = await ensureHost(window);
    if (host.closed) throw new Error("sweetview: cannot open tab in a closed window");

    const id = nextTabId++;
    const initialTitle = options.title ?? (options.url ? new URL(options.url).hostname || options.url : `Tab ${id}`);
    // The webview is a child of the frame; this borrowed wrapper of the frame is what it is attached to.
    const paneWin = Window.fromHandle(host.frame.hwnd);

    // The tab's logical host changes on tear-off and merge; until the record
    // exists it is the host the tab opens in.
    let owner: WinTabRecord | undefined;
    const logicalHost = () => owner?.window ?? host;
    // Set once the tab's webview is going away (closed, abandoned, or a failed
    // attach); native handlers added during the attach check it.
    let gone = false;
    const isGone = () => gone || (owner?.closed ?? false);
    const cleanups = cleanupList();
    const native: { controller?: Controller } = {};
    let navEpoch = 0;
    const onKey = (key: Key): boolean => {
      const found = shortcutFor(key);
      if (found !== undefined) later(() => handleShortcut(logicalHost(), found));
      return found !== undefined;
    };
    const hooks: TabAttachHooks = {
      fileDropHost: () => logicalHost().window,
      // Hidden until present() shows it as the selected tab.
      mountChild: () => ({ window: host.frame.hwnd, bounds: host.frame.pageRect(), visible: false }),
      revealWindow: () => {
        const h = logicalHost();
        if (!h.closed && !isWindowDisposed(h.window) && !h.window.isVisible()) h.window.show();
      },
      // A disposed window abandons the attach before it touches the frame again.
      isCancelled: () => host.closed,
      // Registered before the first navigation starts, so even an initial
      // navigation that fails at once (a refused port) shows the failed-load page.
      beforeNavigate: (raw: RawWebview) => {
        const controller = controllerOf(raw);
        native.controller = controller;
        // Host navigation intent: every navigate/setHTML issued on this tab's webview (the
        // initial one included, which follows this hook) bumps it, so a failed navigation's
        // error page never overwrites a navigation the host asked for after it started.
        const navigate = raw.navigate.bind(raw);
        const setHTML = raw.setHTML.bind(raw);
        raw.navigate = (url: string) => {
          navEpoch++;
          navigate(url);
        };
        raw.setHTML = (html: string) => {
          navEpoch++;
          setHTML(html);
        };
        cleanups.add(onAcceleratorKey(controller, onKey));
        cleanups.add(onNewWindowRequested(controller, (url) => {
          const record = owner;
          if (isGone() || record === undefined) return;
          if (/^https?:\/\//i.test(url)) {
            void winTabsDriver.openTab(record.window.window, { url, after: record.api }).catch(console.error);
          }
        }));
        if (options.url) {
          const address = options.url;
          raw.bind("__sweetviewTabTitle", (t: unknown) => {
            if (typeof t === "string") later(() => owner && renameTab(owner, t));
          });
          raw.init(FOLLOW_TITLE);
          // The failed-load page, as on macOS. It is shown synchronously inside
          // NavigationCompleted (NavigateToString is asynchronous and supported there),
          // and only while the failed navigation is still the latest one. Deferring it
          // would let a caller's navigate(B) race ahead and then be overwritten. The
          // error page's own data: navigation is skipped by onNavigationFailed.
          cleanups.add(onNavigationFailed(controller, ({ url, reason, isCurrent }) => {
            if (isGone() || !isCurrent()) return;
            const failedAt = /^https?:\/\//i.test(url) ? url : address;
            try {
              raw.setHTML(loadFailedPage(failedAt, reason));
            } catch (err) {
              console.error("sweetview: tab action threw:", err);
            }
          }, () => navEpoch));
        }
      },
      // However the webview is disposed (closeTab, abandon, a direct
      // tab.webview.dispose()), its WebView2 handlers go first.
      beforeDestroy: () => {
        gone = true;
        // A direct tab.webview.dispose(): take the tab out of its host before the
        // controller is released, so focus, selection, moves and tear-off never reach it.
        if (owner !== undefined && !owner.closed) releaseDisposedTab(owner);
        cleanups.run();
      },
    };
    const attachOptions: WebViewOptions<M> & { [tabAttachHooks]: TabAttachHooks } = {
      ...options,
      title: initialTitle,
      [tabAttachHooks]: hooks,
    };

    // Until the record is listed in host.tabs, disposeHost never sees this tab:
    // release its webview and borrowed window here.
    const abandon = (webview?: WebView<M, E>) => {
      gone = true;
      cleanups.run();
      webview?.dispose();
      paneWin.dispose();
    };
    let webview: WebView<M, E>;
    let controller: Controller;
    // Until the attach and any rollback finish, a window disposal must not destroy
    // the frame under WebView2 initialization: it waits for this release.
    const releaseFrameDispose = holdWindowNativeDispose(window);
    try {
      try {
        webview = await WebView.attach<M, E>(paneWin, attachOptions);
      } catch (err) {
        abandon();
        throw err;
      }
      if (host.closed || isWindowDisposed(window)) {
        abandon(webview);
        throw new Error("sweetview: the window was disposed while the tab was opening");
      }
      try {
        if (native.controller === undefined) throw new Error("sweetview: the tab's webview has no browser controller");
        controller = native.controller;
      } catch (err) {
        abandon(webview);
        throw err;
      }
    } finally {
      releaseFrameDispose();
    }

    const afterRec = options.after ? tabRecordByApi.get(options.after) : undefined;
    const base = afterRec && afterRec.window === host ? afterRec : host.selected;
    const insertAt = base ? host.tabs.indexOf(base) + 1 : host.tabs.length;

    const record: WinTabRecord = {
      id,
      title: initialTitle,
      window: host,
      webview,
      wrappedWin: paneWin,
      hooks,
      controller,
      cleanups,
      closed: false,
      api: null as unknown as Tab<M, E>,
      onKey,
    };
    owner = record;

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
        closeTab(record, true);
      },
    };
    record.api = api;
    tabRecordByApi.set(api, record);

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
