// macOS TabsDriver: wires virtual Window({ tabs: true }) controllers to
// AppKit window tabbing (@n1h/sweetview-native/darwin/tabs) and WKWebView
// lifecycle hooks (./darwin-webview).

import { WebView, tabAttachHooks, type Tab, type TabAttachHooks, type TabOptions, type TabsDriver, type WebViewOptions } from "../app";
import type { EventMap, MethodMap } from "@n1h/sweetview-ipc";
import { NIL, type Id, asId, sel, send, sendPtr, sendRectBool, sendRetBool, sharedApp } from "@n1h/sweetview-native/darwin/objc";
import { fromCocoa, rectOf, toCocoa } from "@n1h/sweetview-native/darwin/screen";
import { createWindowTabs, installTabMenus, pooled, type WindowTabs } from "@n1h/sweetview-native/darwin/tabs";
import { bindDarwinTabGroup, startDarwinWindowDrag, startDarwinWindowResize, stopDarwinWindowResize, subscribeDarwinFileDrop } from "@n1h/sweetview-native/darwin/window";
import { Window, type Rect, type ResizeEdge } from "@n1h/sweetview-native";
import {
  emitWindowNewTab,
  emitWindowTabClose,
  emitWindowTabSelect,
  forwardWindowTabEvents,
  getWindowBackend,
  getWindowMeta,
  isWindowDisposed,
  onWindowDispose,
} from "@n1h/sweetview-native/internal";
import { detachPage, focusWebView, forgetPage, markTabClosing, onLoadFailed, onNewWindowRequested, openPage } from "./darwin-webview";
import { loadFailedPage } from "./load-failed";

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

type MacTabRecord = {
  readonly nsWin: Id;
  host: MacTabHost;
  title: string;
  webview: WebView<any, any>;
  /** The borrowed `Window.fromHandle(nsWin)` the webview is attached to; disposed right after `webview`. */
  readonly wrappedWin: Window;
  /** Attach hooks; `rebindFileDrop` moves webview file-drop delivery to the current `host.window`. */
  readonly hooks: TabAttachHooks;
  shown: boolean;
  closed: boolean;
  /** True only while `tab.close()` is inside `performClose:`; see `onCloseRequest`. */
  closingByApi?: boolean;
  api: Tab<any, any>;
  stopFileDrop?: () => void;
};

type PendingShow = {
  readonly nsWin: Id;
  /** An explicit same-host `after` anchor; otherwise the anchor is resolved when the tab is shown. */
  readonly after?: Id;
};

type MacTabHost = {
  readonly window: Window;
  /** AppKit tabbing group, shared with the hosts torn off from it. */
  readonly group: WindowTabs;
  readonly tabs: Map<Id, MacTabRecord>;
  /**
   * Tab NSWindows created for `openTab` whose `WebView.attach` is still in
   * flight. They are not in `tabs` yet; `openTab` discards them on rollback,
   * and the group is kept alive until it has.
   */
  readonly attaching: Set<Id>;
  readonly pendingShow: PendingShow[];
  readonly minWidth: number;
  readonly minHeight: number;
  selectedBeforeShow?: Id;
  /** Last known outer frame; used while the host has no shown tab window. */
  bounds: Rect;
  title: string;
  topmost: boolean;
  visible: boolean;
  closed: boolean;
  fireResize: (bounds: Rect) => void;
  fireMove: (bounds: Rect) => void;
  fireClose: () => boolean;
  fireFileDrop: (paths: string[]) => void;
  fileDropEnabled: boolean;
};

const hosts = new Map<Window, MacTabHost>();
const recordByNsWin = new Map<Id, MacTabRecord>();
const tabRecordByApi = new WeakMap<object, MacTabRecord>();
/**
 * Hosts still using each shared AppKit group. A host leaves only once it is
 * closed, its teardown has finished, and no attach of its is in flight; the
 * group is disposed when the last one leaves, so a nested or concurrent
 * teardown never disposes a group another host is still closing or attaching into.
 */
const activeGroupRefs = new Map<WindowTabs, Set<MacTabHost>>();
let nextGroupId = 1;
let nextTabId = 1;

function retainGroup(host: MacTabHost): void {
  let refs = activeGroupRefs.get(host.group);
  if (!refs) activeGroupRefs.set(host.group, (refs = new Set()));
  refs.add(host);
}

/** Drops `host`'s use of its group once it is closed with no attach in flight; disposes the group after the last user. */
function releaseGroupIfIdle(host: MacTabHost): void {
  if (!host.closed || host.attaching.size > 0) return;
  const refs = activeGroupRefs.get(host.group);
  if (!refs?.delete(host) || refs.size > 0) return;
  activeGroupRefs.delete(host.group);
  host.group.dispose();
}

function syncFileDrop(record: MacTabRecord): void {
  if (record.host.fileDropEnabled && !record.closed) {
    record.stopFileDrop ??= subscribeDarwinFileDrop(record.nsWin, (paths) => record.host.fireFileDrop(paths));
  } else {
    record.stopFileDrop?.();
    record.stopFileDrop = undefined;
  }
}

/** Moves a tab record to `host`: native and webview file-drop delivery, and window level. */
function rehome(record: MacTabRecord, host: MacTabHost): void {
  // A resize gesture started through the old host must not keep driving the window.
  stopDarwinWindowResize(record.nsWin);
  record.host = host;
  // Resubscribe so the NSWindow drop handler delivers to the new host only.
  record.stopFileDrop?.();
  record.stopFileDrop = undefined;
  syncFileDrop(record);
  record.hooks.rebindFileDrop?.();
  host.group.setTopmost(record.nsWin, host.topmost);
}

/**
 * Disposes one logical host. Only the tab NSWindows this host owns are
 * closed (tabs torn off into other hosts stay open). Tab windows still
 * attaching are left to `openTab`'s rollback, and the shared AppKit group is
 * disposed only after every host using it has finished (see `releaseGroupIfIdle`).
 */
function disposeMacHost(host: MacTabHost): void {
  if (host.closed) return;
  host.closed = true;
  hosts.delete(host.window);
  host.pendingShow.length = 0;
  host.selectedBeforeShow = undefined;
  for (const [nsWin, rec] of [...host.tabs]) {
    host.tabs.delete(nsWin);
    recordByNsWin.delete(nsWin);
    stopDarwinWindowResize(nsWin);
    if (!rec.closed) {
      rec.closed = true;
      syncFileDrop(rec);
      detachPage(nsWin);
      rec.webview.dispose();
      rec.wrappedWin.dispose();
    }
    if (rec.shown) pooled(() => send(nsWin, sel("close")));
    else host.group.discard(nsWin);
    forgetPage(nsWin);
  }
  releaseGroupIfIdle(host);
}

/** A shown, open tab window of `host`: the group's current window when it is one, else the first. */
function activeTab(host: MacTabHost): Id | undefined {
  const cur = host.group.current();
  const curRec = cur !== undefined ? host.tabs.get(cur) : undefined;
  if (cur !== undefined && curRec?.shown && !curRec.closed) return cur;
  for (const [nsWin, rec] of host.tabs) if (rec.shown && !rec.closed) return nsWin;
  return undefined;
}

function showTab(host: MacTabHost, record: MacTabRecord, after: Id | undefined): void {
  const afterRec = after !== undefined ? host.tabs.get(after) : undefined;
  const anchor = afterRec?.shown && !afterRec.closed ? after : activeTab(host);
  record.shown = true;
  // No shown tab of this host: open standalone, never into the group's
  // current window, which may belong to a torn-off sibling host.
  host.group.show(record.nsWin, anchor ?? null, (w) => {
    if (anchor === undefined) {
      // The host's first tab window takes the host's frame.
      const c = toCocoa(host.bounds);
      sendRectBool(w, sel("setFrame:display:"), c.x, c.y, c.w, c.h, false);
    }
    focusWebView(w);
  });
}

function flushPendingShow(host: MacTabHost): void {
  if (host.closed) return;
  const queued = host.pendingShow.splice(0, host.pendingShow.length);
  for (const item of queued) {
    const rec = host.tabs.get(item.nsWin);
    if (!rec || rec.closed || rec.shown) continue;
    showTab(host, rec, item.after);
  }
  if (host.selectedBeforeShow !== undefined) {
    const selWin = host.selectedBeforeShow;
    host.selectedBeforeShow = undefined;
    const rec = host.tabs.get(selWin);
    if (rec && !rec.closed && rec.shown) host.group.select(selWin);
  }
}

function bindHostToWindow(window: Window, group: WindowTabs, initialBounds: Rect): MacTabHost {
  const meta = getWindowMeta(window);
  const tabs = new Map<Id, MacTabRecord>();
  let fileDropEnabled = false;
  let host!: MacTabHost;
  const activeWin = (): Id | undefined => activeTab(host);
  const bounds = (): Rect => {
    const cur = activeWin();
    if (cur !== undefined) host.bounds = pooled(() => fromCocoa(rectOf(cur, "frame")));
    return host.bounds;
  };
  const setBounds = (rect: Rect) => {
    host.bounds = { ...rect };
    const cur = activeWin();
    if (cur !== undefined) {
      pooled(() => {
        const c = toCocoa(rect);
        sendRectBool(cur, sel("setFrame:display:"), c.x, c.y, c.w, c.h, true);
      });
    }
  };

  const hooks = bindDarwinTabGroup(getWindowBackend(window), {
    show() {
      if (host.closed) return;
      host.visible = true;
      // Bring back the tabs hide() ordered out before anchoring queued tabs to them.
      const cur = activeWin();
      if (cur !== undefined) group.select(cur);
      flushPendingShow(host);
    },
    hide() {
      if (host.closed) return;
      host.visible = false;
      pooled(() => {
        for (const [nsWin, rec] of tabs) {
          if (rec.shown && !rec.closed) sendPtr(nsWin, sel("orderOut:"), NIL);
        }
      });
    },
    isVisible() {
      return !host.closed && host.visible && activeWin() !== undefined;
    },
    bounds,
    setBounds,
    setTitle(title: string) {
      host.title = title;
      const cur = activeWin();
      const rec = cur !== undefined ? tabs.get(cur) : undefined;
      // Through the tab API so the tab's recorded title matches its NSWindow title.
      rec?.api.setTitle(title);
    },
    minimize() {
      const cur = activeWin();
      if (cur !== undefined) pooled(() => sendPtr(cur, sel("miniaturize:"), NIL));
    },
    toggleMaximize() {
      if (meta.resizable === false) return;
      const cur = activeWin();
      if (cur !== undefined) pooled(() => sendPtr(cur, sel("zoom:"), NIL));
    },
    isMaximized() {
      const cur = activeWin();
      return cur !== undefined ? pooled(() => Boolean(sendRetBool(cur, sel("isZoomed")))) : false;
    },
    isMinimized() {
      const cur = activeWin();
      return cur !== undefined ? pooled(() => Boolean(sendRetBool(cur, sel("isMiniaturized")))) : false;
    },
    dispose() {
      disposeMacHost(host);
    },
    setFileDropEnabled(enabled) {
      fileDropEnabled = enabled;
      if (host) host.fileDropEnabled = enabled;
      for (const record of tabs.values()) syncFileDrop(record);
    },
    setTopmost(on) {
      if (host.closed) return;
      host.topmost = on;
      for (const nsWin of tabs.keys()) group.setTopmost(nsWin, on);
    },
    startDrag() {
      const cur = activeWin();
      if (cur === undefined || host.closed) return;
      pooled(() => startDarwinWindowDrag(cur));
    },
    startResize(edge: ResizeEdge) {
      if (host.closed || meta.resizable === false) return;
      const nsWin = activeWin();
      const rec = nsWin !== undefined ? tabs.get(nsWin) : undefined;
      if (nsWin === undefined || !rec) return;
      // The gesture is bound to the window it started on: it stops if that
      // window closes or moves to another host, and never follows activeWin().
      const ended = () => host.closed || rec.closed || rec.host !== host;
      startDarwinWindowResize(
        nsWin,
        edge,
        host.minWidth,
        host.minHeight,
        () => pooled(() => fromCocoa(rectOf(nsWin, "frame"))),
        (rect) => {
          if (ended()) return;
          host.bounds = { ...rect };
          pooled(() => {
            const c = toCocoa(rect);
            sendRectBool(nsWin, sel("setFrame:display:"), c.x, c.y, c.w, c.h, true);
          });
        },
        ended,
      );
    },
    activeHandle() {
      return host.closed ? null : (activeWin() ?? null);
    },
  });

  host = {
    window,
    group,
    tabs,
    attaching: new Set(),
    pendingShow: [],
    minWidth: meta.minWidth ?? 480,
    minHeight: meta.minHeight ?? 320,
    bounds: { ...initialBounds },
    title: meta.title,
    topmost: meta.topmost ?? false,
    visible: false,
    closed: false,
    fireResize: hooks.fireResize,
    fireMove: hooks.fireMove,
    fireClose: hooks.fireClose,
    fireFileDrop: hooks.fireFileDrop,
    fileDropEnabled,
  };
  hosts.set(window, host);
  retainGroup(host);
  onWindowDispose(window, () => disposeMacHost(host));
  // Apply state set on the Window before this bind (visibility, title, bounds, topmost) now that `host` exists.
  hooks.replay();
  return host;
}

function ensureHost(window: Window): MacTabHost {
  const existing = hosts.get(window);
  if (existing) return existing;
  const meta = getWindowMeta(window);
  if (!meta.tabs) {
    throw new Error("sweetview: WebView.openTab requires a Window created with { tabs: true }");
  }
  if (isWindowDisposed(window)) {
    throw new Error("sweetview: cannot open tab in a disposed window");
  }
  installTabMenus();

  const b = window.bounds();
  const group = createWindowTabs({
    identifier: `sweetview.tabs.${nextGroupId++}`,
    bounds: b,
    width: b.width || 1040,
    height: b.height || 720,
    minWidth: meta.minWidth ?? 480,
    minHeight: meta.minHeight ?? 320,
    appearance: meta.appearance,
    resizable: meta.resizable,
    topmost: meta.topmost,
    opacity: meta.opacity,
    hideFromTaskbar: meta.hideFromTaskbar,
    noActivate: meta.noActivate,
    onNewTabRequest: () => {
      const cur = group.current();
      const targetWin = (cur !== undefined ? recordByNsWin.get(cur)?.host.window : undefined) ?? window;
      emitWindowNewTab(targetWin);
    },
    onSelected: (nsWin) => {
      const rec = recordByNsWin.get(nsWin);
      if (rec && !rec.closed) emitWindowTabSelect(rec.host.window, rec.api);
    },
    onResized: (nsWin) => {
      const rec = recordByNsWin.get(nsWin);
      if (!rec || rec.host.closed) return;
      const frame = pooled(() => fromCocoa(rectOf(nsWin, "frame")));
      rec.host.bounds = frame;
      rec.host.fireResize(frame);
    },
    onMoved: (nsWin) => {
      const rec = recordByNsWin.get(nsWin);
      if (!rec || rec.host.closed) return;
      const frame = pooled(() => fromCocoa(rectOf(nsWin, "frame")));
      rec.host.bounds = frame;
      rec.host.fireMove(frame);
    },
    onCloseRequest: (nsWin) => {
      const record = recordByNsWin.get(nsWin);
      // tab.close() always closes its tab; only a close the user asked for
      // (the close button, Close Tab) on a window's last tab is first offered
      // to the window's onClose listeners.
      if (record === undefined || record.closingByApi) return false;
      const host = record.host;
      return host.tabs.size === 1 && host.fireClose();
    },
    // Synchronous, unlike onClosed: no queued popup opening fires once the close began.
    onWillClose: (nsWin) => markTabClosing(nsWin),
    onClosed: (nsWin) => {
      // Deferred from willClose: a record a host teardown already removed was
      // detached there, so never detach it again or pump events at its torn-down host.
      const rec = recordByNsWin.get(nsWin);
      if (!rec) return;
      recordByNsWin.delete(nsWin);
      stopDarwinWindowResize(nsWin);
      detachPage(nsWin);
      const tabHost = rec.host;
      tabHost.tabs.delete(nsWin);
      if (!rec.closed) {
        rec.closed = true;
        syncFileDrop(rec);
        rec.webview.dispose();
        rec.wrappedWin.dispose();
        emitWindowTabClose(tabHost.window, rec.api);
      }
      forgetPage(nsWin);
      if (tabHost.tabs.size === 0 && !tabHost.closed) {
        if (!tabHost.fireClose()) tabHost.window.dispose();
      }
    },
  });

  return bindHostToWindow(window, group, b);
}

export const darwinTabsDriver: TabsDriver = {
  async openTab<M extends MethodMap, E extends EventMap>(window: Window, options: TabOptions<M>): Promise<Tab<M, E>> {
    const host = ensureHost(window);
    if (host.closed) throw new Error("sweetview: cannot open tab in a disposed window");

    const id = nextTabId++;
    const initialTitle = options.title ?? (options.url ? new URL(options.url).hostname || options.url : `Tab ${id}`);
    const nsWin = host.group.createWindow(initialTitle);
    openPage(nsWin);
    host.group.setTopmost(nsWin, host.topmost);
    // While attaching, a host teardown leaves nsWin (and the group) alive for the rollback below.
    host.attaching.add(nsWin);
    let wrappedWin: Window;
    try {
      wrappedWin = Window.fromHandle(nsWin);
    } catch (err) {
      host.attaching.delete(nsWin);
      host.group.discard(nsWin);
      forgetPage(nsWin);
      releaseGroupIfIdle(host);
      throw err;
    }
    // Undo an attach that did not produce a tab; `webview` is set when the attach itself succeeded.
    const rollback = (webview?: WebView<any, any>) => {
      if (webview) {
        detachPage(nsWin);
        webview.dispose();
      }
      wrappedWin.dispose();
      host.attaching.delete(nsWin);
      host.group.discard(nsWin);
      forgetPage(nsWin);
      releaseGroupIfIdle(host);
    };

    // The tab's logical host changes on tear-off and merge; until the record
    // exists it is the host the tab opens in.
    let owner: MacTabRecord | undefined;
    const logicalHost = () => owner?.host ?? host;
    const hooks: TabAttachHooks = {
      fileDropHost: () => logicalHost().window,
      revealWindow: () => {
        const h = logicalHost();
        if (!h.closed && !isWindowDisposed(h.window) && !h.window.isVisible()) h.window.show();
      },
      isCancelled: () => host.closed,
      // Installed before the first navigation starts, so a load that fails at
      // once (a refused port) still shows the failed-load page.
      beforeNavigate: (raw) => {
        // HTTP(S) target="_blank" links and window.open() open a tab after this one, as in the Windows driver.
        onNewWindowRequested(nsWin, (url) => {
          const record = owner;
          if (record === undefined || record.closed) return;
          void darwinTabsDriver.openTab(record.host.window, { url, after: record.api }).catch(console.error);
        });
        if (options.url) {
          const address = options.url;
          raw.bind("__sweetviewTabTitle", (t: unknown) => {
            if (typeof t === "string") owner?.api.setTitle(t);
          });
          raw.init(FOLLOW_TITLE);
          // The failed-load page, as on Windows. Its own about:blank load is never a failure to replace.
          onLoadFailed(nsWin, (url, reason) => {
            if (owner?.closed || /^(about|data):/i.test(url)) return;
            raw.setHTML(loadFailedPage(url || address, reason));
          });
        }
      },
      // However the webview is disposed (a tab close, a rollback, a direct
      // tab.webview.dispose()), the library's own UIDelegate is back before
      // WKWebView teardown releases it.
      beforeDestroy: () => detachPage(nsWin),
    };
    const attachOptions: WebViewOptions<M> & { [tabAttachHooks]: TabAttachHooks } = {
      ...options,
      title: initialTitle,
      [tabAttachHooks]: hooks,
    };

    let webview: WebView<M, E>;
    try {
      webview = await WebView.attach<M, E>(wrappedWin, attachOptions);
    } catch (err) {
      rollback();
      throw err;
    }
    if (host.closed || isWindowDisposed(window)) {
      rollback(webview);
      throw new Error("sweetview: the window was disposed while the tab was opening");
    }
    host.attaching.delete(nsWin);
    // setTopmost() during the attach updated only the host's listed tabs.
    host.group.setTopmost(nsWin, host.topmost);

    const record: MacTabRecord = {
      nsWin,
      host,
      title: initialTitle,
      webview,
      wrappedWin,
      hooks,
      shown: false,
      closed: false,
      api: null as unknown as Tab<M, E>,
    };
    owner = record;

    const api: Tab<M, E> = {
      webview,
      get window() {
        return record.host.window;
      },
      get title() {
        return record.title;
      },
      setTitle(title: string) {
        if (record.closed) return;
        record.title = title.trim() || `Tab ${id}`;
        record.host.group.setTitle(nsWin, record.title);
      },
      select() {
        if (record.closed) return;
        if (record.shown) record.host.group.select(nsWin);
        else record.host.selectedBeforeShow = nsWin;
      },
      close() {
        if (record.closed) return;
        // A shown tab is marked closing by onWillClose (performClose: can be vetoed); an unshown one by detachPage.
        const tabHost = record.host;
        if (record.shown) {
          // As on Windows, the tab closes even when it is its window's last:
          // onTabClose fires, and then the emptied window's onClose
          // listeners run (or, with none, the window is disposed) from
          // onClosed. performClose: runs the close request synchronously.
          record.closingByApi = true;
          try {
            tabHost.group.close(nsWin);
          } finally {
            record.closingByApi = false;
          }
        } else {
          record.closed = true;
          stopDarwinWindowResize(nsWin);
          syncFileDrop(record);
          tabHost.tabs.delete(nsWin);
          recordByNsWin.delete(nsWin);
          const idx = tabHost.pendingShow.findIndex((p) => p.nsWin === nsWin);
          if (idx !== -1) tabHost.pendingShow.splice(idx, 1);
          if (tabHost.selectedBeforeShow === nsWin) tabHost.selectedBeforeShow = undefined;
          detachPage(nsWin);
          record.webview.dispose();
          record.wrappedWin.dispose();
          tabHost.group.discard(nsWin);
          forgetPage(nsWin);
          emitWindowTabClose(tabHost.window, api);
          if (tabHost.tabs.size === 0 && !tabHost.closed) {
            if (!tabHost.fireClose()) tabHost.window.dispose();
          }
        }
      },
      async moveToNewWindow() {
        if (record.closed) return record.host.window;
        const fromHost = record.host;
        if (!record.shown) {
          // Detach ONLY this tab without revealing unrelated hidden pending tabs.
          const idx = fromHost.pendingShow.findIndex((p) => p.nsWin === nsWin);
          if (idx !== -1) fromHost.pendingShow.splice(idx, 1);
          if (fromHost.selectedBeforeShow === nsWin) fromHost.selectedBeforeShow = undefined;
          record.shown = true;
          // Standalone: never tab into the group's current window, which may be another host's.
          fromHost.group.show(nsWin, null, (w) => focusWebView(w));
        } else {
          fromHost.group.moveToNewWindow(nsWin);
        }
        const meta = getWindowMeta(fromHost.window);
        const frame = pooled(() => fromCocoa(rectOf(nsWin, "frame")));
        const detachedWin = new Window({
          tabs: true,
          title: record.title,
          bounds: frame,
          appearance: meta.appearance,
          icon: meta.icon,
          resizable: meta.resizable,
          opacity: meta.opacity,
          hideFromTaskbar: meta.hideFromTaskbar,
          noActivate: meta.noActivate,
          minWidth: meta.minWidth,
          minHeight: meta.minHeight,
          topmost: fromHost.topmost,
        });
        const detachedHost = bindHostToWindow(detachedWin, fromHost.group, frame);
        detachedHost.visible = true;
        forwardWindowTabEvents(detachedWin, fromHost.window);
        fromHost.tabs.delete(nsWin);
        detachedHost.tabs.set(nsWin, record);
        rehome(record, detachedHost);
        return detachedWin;
      },
      dispose() {
        api.close();
      },
    };
    record.api = api;
    tabRecordByApi.set(api, record);
    recordByNsWin.set(nsWin, record);
    host.tabs.set(nsWin, record);
    syncFileDrop(record);

    // `after` anchors only within this host: a tab of another window, or a
    // closed tab, is ignored as in the Windows driver.
    const afterRec = options.after ? tabRecordByApi.get(options.after) : undefined;
    const after = afterRec && afterRec.host === host && !afterRec.closed ? afterRec.nsWin : undefined;
    if (host.visible) {
      showTab(host, record, after);
      emitWindowTabSelect(window, api);
    } else {
      // The default anchor is resolved when the host is shown: tabs hide() ordered out are not anchors.
      host.pendingShow.push({ nsWin, after });
      host.selectedBeforeShow ??= nsWin;
    }
    return api;
  },

  mergeAllWindows(into?: Window) {
    const preferred = into ? hosts.get(into) : undefined;
    const target = preferred ?? hosts.values().next().value;
    if (!target) return;
    target.group.mergeAllWindows();
    // Re-associate detached hosts sharing this tabbing group back into `target`.
    for (const h of [...hosts.values()]) {
      if (h === target || h.group !== target.group) continue;
      for (const [nsWin, rec] of [...h.tabs]) {
        h.tabs.delete(nsWin);
        target.tabs.set(nsWin, rec);
        rehome(rec, target);
      }
      for (const item of h.pendingShow.splice(0)) target.pendingShow.push({ nsWin: item.nsWin });
      h.selectedBeforeShow = undefined;
      // The emptied host owns no tab windows now, so disposing its Window closes none (as on Windows).
      h.window.dispose();
      disposeMacHost(h);
    }
    if (target.visible) flushPendingShow(target);
  },

  disposeWindow(window: Window) {
    const host = hosts.get(window);
    if (host) disposeMacHost(host);
  },
};
