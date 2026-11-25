// macOS TabsDriver: wires virtual Window({ tabs: true }) controllers to
// AppKit window tabbing (src/native/darwin/tabs.ts) and WKWebView lifecycle
// hooks (src/tabs/darwin-webview.ts).

import { WebView, type Tab, type TabOptions, type TabsDriver } from "../app";
import type { EventMap, MethodMap } from "../ipc";
import { NIL, type Id, sel, sendPtr, sendRectBool, sendRetBool } from "../native/darwin/objc";
import { fromCocoa, rectOf, toCocoa } from "../native/darwin/screen";
import { createWindowTabs, installTabMenus, pooled, type WindowTabs } from "../native/darwin/tabs";
import { bindDarwinTabGroup } from "../native/darwin/window";
import {
  Window,
  emitWindowNewTab,
  emitWindowTabClose,
  emitWindowTabSelect,
  forwardWindowTabEvents,
  getWindowBackend,
  getWindowMeta,
  isWindowDisposed,
  onWindowDispose,
  type Rect,
} from "../native/window";
import { detachPage, focusWebView, onLoadFailed } from "./darwin-webview";

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

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const loadFailedPage = (address: string, reason: string) => `<!doctype html>
<html lang="en"><meta charset="utf-8" /><meta name="color-scheme" content="light dark" />
<title>${escapeHtml(address)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;font:15px/1.5 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:520px}</style>
<main><h1>This site did not open</h1><p>${escapeHtml(address)}</p><p>${escapeHtml(reason)}</p><a href="${escapeHtml(address)}">Try Again</a></main></html>`;

type MacTabRecord = {
  readonly nsWin: Id;
  host: MacTabHost;
  title: string;
  webview: WebView<any, any>;
  shown: boolean;
  closed: boolean;
  api: Tab<any, any>;
};

type PendingShow = {
  readonly nsWin: Id;
  readonly after?: Id;
};

type MacTabHost = {
  readonly window: Window;
  readonly group: WindowTabs;
  readonly ownsGroup: boolean;
  readonly tabs: Map<Id, MacTabRecord>;
  readonly pendingShow: PendingShow[];
  selectedBeforeShow?: Id;
  visible: boolean;
  closed: boolean;
  fireResize: (bounds: Rect) => void;
  fireMove: (bounds: Rect) => void;
  fireClose: () => boolean;
};

const hosts = new Map<Window, MacTabHost>();
const recordByNsWin = new Map<Id, MacTabRecord>();
const tabRecordByApi = new WeakMap<object, MacTabRecord>();
let nextGroupId = 1;
let nextTabId = 1;

function disposeMacHost(host: MacTabHost): void {
  if (host.closed) return;
  host.closed = true;
  hosts.delete(host.window);
  host.pendingShow.length = 0;
  for (const [nsWin, rec] of [...host.tabs]) {
    host.tabs.delete(nsWin);
    recordByNsWin.delete(nsWin);
    if (!rec.closed) {
      rec.closed = true;
      detachPage(nsWin);
      rec.webview.dispose();
    }
  }
  if (host.ownsGroup) host.group.dispose();
}

function flushPendingShow(host: MacTabHost): void {
  if (host.closed) return;
  const queued = host.pendingShow.splice(0, host.pendingShow.length);
  for (const item of queued) {
    const rec = host.tabs.get(item.nsWin);
    if (!rec || rec.closed || rec.shown) continue;
    rec.shown = true;
    host.group.show(item.nsWin, item.after, (w) => focusWebView(w));
  }
  if (host.selectedBeforeShow !== undefined) {
    const selWin = host.selectedBeforeShow;
    host.selectedBeforeShow = undefined;
    const rec = host.tabs.get(selWin);
    if (rec && !rec.closed && rec.shown) host.group.select(selWin);
  }
}

function bindHostToWindow(window: Window, group: WindowTabs, ownsGroup: boolean, initialBounds: Rect): MacTabHost {
  const tabs = new Map<Id, MacTabRecord>();
  let host!: MacTabHost;
  const activeWin = (): Id | undefined => {
    const cur = group.current();
    if (cur !== undefined && tabs.has(cur)) return cur;
    for (const [nsWin, rec] of tabs) if (rec.shown && !rec.closed) return nsWin;
    return undefined;
  };

  const hooks = bindDarwinTabGroup(getWindowBackend(window), {
    show() {
      host.visible = true;
      flushPendingShow(host);
      const cur = activeWin();
      if (cur !== undefined) group.select(cur);
    },
    hide() {
      host.visible = false;
      pooled(() => {
        for (const [nsWin, rec] of tabs) {
          if (rec.shown) sendPtr(nsWin, sel("orderOut:"), NIL);
        }
      });
    },
    isVisible() {
      return host.visible && activeWin() !== undefined;
    },
    bounds(): Rect {
      const cur = activeWin();
      return cur !== undefined ? pooled(() => fromCocoa(rectOf(cur, "frame"))) : initialBounds;
    },
    setBounds(rect: Rect) {
      const cur = activeWin();
      if (cur !== undefined) {
        pooled(() => {
          const c = toCocoa(rect);
          sendRectBool(cur, sel("setFrame:display:"), c.x, c.y, c.w, c.h, true);
        });
      }
    },
    setTitle(title: string) {
      const cur = activeWin();
      if (cur !== undefined) group.setTitle(cur, title);
    },
    minimize() {
      const cur = activeWin();
      if (cur !== undefined) pooled(() => sendPtr(cur, sel("miniaturize:"), NIL));
    },
    toggleMaximize() {
      const cur = activeWin();
      if (cur !== undefined) pooled(() => sendPtr(cur, sel("zoom:"), NIL));
    },
    isMaximized() {
      const cur = activeWin();
      return cur !== undefined ? pooled(() => Boolean(sendRetBool(cur, sel("isZoomed")))) : false;
    },
    dispose() {
      disposeMacHost(host);
    },
  });

  host = {
    window,
    group,
    ownsGroup,
    tabs,
    pendingShow: [],
    visible: false,
    closed: false,
    fireResize: hooks.fireResize,
    fireMove: hooks.fireMove,
    fireClose: hooks.fireClose,
  };
  hosts.set(window, host);
  onWindowDispose(window, () => disposeMacHost(host));
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
      if (rec && !rec.host.closed) rec.host.fireResize(pooled(() => fromCocoa(rectOf(nsWin, "frame"))));
    },
    onMoved: (nsWin) => {
      const rec = recordByNsWin.get(nsWin);
      if (rec && !rec.host.closed) rec.host.fireMove(pooled(() => fromCocoa(rectOf(nsWin, "frame"))));
    },
    onClosed: (nsWin) => {
      const rec = recordByNsWin.get(nsWin);
      recordByNsWin.delete(nsWin);
      detachPage(nsWin);
      if (!rec) return;
      const tabHost = rec.host;
      tabHost.tabs.delete(nsWin);
      if (!rec.closed) {
        rec.closed = true;
        rec.webview.dispose();
        emitWindowTabClose(tabHost.window, rec.api);
      }
      if (tabHost.tabs.size === 0 && !tabHost.closed) {
        if (!tabHost.fireClose()) tabHost.window.dispose();
      }
    },
  });

  return bindHostToWindow(window, group, true, b);
}

export const darwinTabsDriver: TabsDriver = {
  async openTab<M extends MethodMap, E extends EventMap>(window: Window, options: TabOptions<M>): Promise<Tab<M, E>> {
    const host = ensureHost(window);
    if (host.closed) throw new Error("sweetview: cannot open tab in a disposed window");

    const id = nextTabId++;
    const initialTitle = options.title ?? (options.url ? new URL(options.url).hostname || options.url : `Tab ${id}`);
    const nsWin = host.group.createWindow(initialTitle);
    const wrappedWin = Window.fromHandle(nsWin);

    let webview: WebView<M, E>;
    try {
      webview = await WebView.attach<M, E>(wrappedWin, { ...options, title: initialTitle });
    } catch (err) {
      host.group.discard(nsWin);
      throw err;
    }

    const record: MacTabRecord = {
      nsWin,
      host,
      title: initialTitle,
      webview,
      shown: false,
      closed: false,
      api: null as unknown as Tab<M, E>,
    };

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
        const tabHost = record.host;
        if (record.shown) {
          tabHost.group.close(nsWin);
        } else {
          record.closed = true;
          tabHost.tabs.delete(nsWin);
          recordByNsWin.delete(nsWin);
          const idx = tabHost.pendingShow.findIndex((p) => p.nsWin === nsWin);
          if (idx !== -1) tabHost.pendingShow.splice(idx, 1);
          detachPage(nsWin);
          record.webview.dispose();
          tabHost.group.discard(nsWin);
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
          record.shown = true;
          fromHost.group.show(nsWin, undefined, (w) => focusWebView(w));
        } else {
          fromHost.group.moveToNewWindow(nsWin);
        }
        const detachedWin = new Window({ tabs: true, title: record.title, bounds: fromHost.window.bounds() });
        const detachedHost = bindHostToWindow(detachedWin, fromHost.group, false, fromHost.window.bounds());
        detachedHost.visible = true;
        forwardWindowTabEvents(detachedWin, fromHost.window);
        fromHost.tabs.delete(nsWin);
        detachedHost.tabs.set(nsWin, record);
        record.host = detachedHost;
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

    if (options.url) {
      webview.raw.bind("__sweetviewTabTitle", (t: unknown) => {
        if (typeof t === "string") api.setTitle(t);
      });
      webview.raw.init(FOLLOW_TITLE);
      onLoadFailed(nsWin, (reason) => webview.raw.setHTML(loadFailedPage(options.url!, reason)));
    }

    const afterRec = options.after ? tabRecordByApi.get(options.after) : undefined;
    // Anchor inside the target host's own tabs if `after` was not specified.
    const anchorNsWin = afterRec?.nsWin ?? [...host.tabs.keys()].find((w) => w !== nsWin && host.tabs.get(w)?.shown);
    if (host.visible) {
      record.shown = true;
      host.group.show(nsWin, anchorNsWin, (w) => focusWebView(w));
      emitWindowTabSelect(window, api);
    } else {
      host.pendingShow.push({ nsWin, after: anchorNsWin });
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
    for (const [win, h] of [...hosts]) {
      if (h === target || h.group !== target.group) continue;
      for (const [nsWin, rec] of [...h.tabs]) {
        h.tabs.delete(nsWin);
        target.tabs.set(nsWin, rec);
        rec.host = target;
      }
      h.closed = true;
      hosts.delete(win);
    }
  },

  disposeWindow(window: Window) {
    const host = hosts.get(window);
    if (host) disposeMacHost(host);
  },
};
