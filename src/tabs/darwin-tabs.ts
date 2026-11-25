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
    if (!rec.closed) {
      rec.closed = true;
      detachPage(nsWin);
      rec.webview.dispose();
    }
  }
  host.group.dispose();
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
  const tabs = new Map<Id, MacTabRecord>();

  let host!: MacTabHost;
  const group = createWindowTabs({
    identifier: `sweetview.tabs.${nextGroupId++}`,
    bounds: b,
    width: b.width || 1040,
    height: b.height || 720,
    minWidth: meta.minWidth ?? 480,
    minHeight: meta.minHeight ?? 320,
    appearance: meta.appearance,
    onNewTabRequest: () => emitWindowNewTab(window),
    onSelected: (nsWin) => {
      const rec = tabs.get(nsWin);
      if (rec && !rec.closed) emitWindowTabSelect(window, rec.api);
    },
    onResized: (nsWin) => {
      if (!host.closed) host.fireResize(pooled(() => fromCocoa(rectOf(nsWin, "frame"))));
    },
    onMoved: (nsWin) => {
      if (!host.closed) host.fireMove(pooled(() => fromCocoa(rectOf(nsWin, "frame"))));
    },
    onClosed: (nsWin) => {
      const rec = tabs.get(nsWin);
      tabs.delete(nsWin);
      detachPage(nsWin);
      if (rec && !rec.closed) {
        rec.closed = true;
        rec.webview.dispose();
        emitWindowTabClose(window, rec.api);
      }
      if (tabs.size === 0 && !host.closed) {
        host.fireClose();
      }
    },
  });

  const hooks = bindDarwinTabGroup(getWindowBackend(window), {
    show() {
      host.visible = true;
      flushPendingShow(host);
      const cur = group.current();
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
      return host.visible && group.count() > 0;
    },
    bounds(): Rect {
      const cur = group.current();
      return cur !== undefined ? pooled(() => fromCocoa(rectOf(cur, "frame"))) : b;
    },
    setBounds(rect: Rect) {
      const cur = group.current();
      if (cur !== undefined) {
        pooled(() => {
          const c = toCocoa(rect);
          sendRectBool(cur, sel("setFrame:display:"), c.x, c.y, c.w, c.h, true);
        });
      }
    },
    setTitle(title: string) {
      const cur = group.current();
      if (cur !== undefined) group.setTitle(cur, title);
    },
    minimize() {
      const cur = group.current();
      if (cur !== undefined) pooled(() => sendPtr(cur, sel("miniaturize:"), NIL));
    },
    toggleMaximize() {
      const cur = group.current();
      if (cur !== undefined) pooled(() => sendPtr(cur, sel("zoom:"), NIL));
    },
    isMaximized() {
      const cur = group.current();
      return cur !== undefined ? pooled(() => Boolean(sendRetBool(cur, sel("isZoomed")))) : false;
    },
    dispose() {
      disposeMacHost(host);
    },
  });

  host = {
    window,
    group,
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
      title: initialTitle,
      webview,
      shown: false,
      closed: false,
      api: null as unknown as Tab<M, E>,
    };

    const api: Tab<M, E> = {
      webview,
      window,
      get title() {
        return record.title;
      },
      setTitle(title: string) {
        if (record.closed) return;
        record.title = title.trim() || `Tab ${id}`;
        host.group.setTitle(nsWin, record.title);
      },
      select() {
        if (record.closed) return;
        if (record.shown) host.group.select(nsWin);
        else host.selectedBeforeShow = nsWin;
      },
      close() {
        if (record.closed) return;
        if (record.shown) {
          host.group.close(nsWin);
        } else {
          record.closed = true;
          host.tabs.delete(nsWin);
          detachPage(nsWin);
          record.webview.dispose();
          host.group.discard(nsWin);
          emitWindowTabClose(window, api);
          if (host.tabs.size === 0 && !host.closed) host.fireClose();
        }
      },
      async moveToNewWindow() {
        if (!record.closed) {
          if (!record.shown) {
            host.visible = true;
            flushPendingShow(host);
          }
          host.group.moveToNewWindow(nsWin);
        }
        return wrappedWin;
      },
      dispose() {
        api.close();
      },
    };
    record.api = api;
    tabRecordByApi.set(api, record);
    host.tabs.set(nsWin, record);

    if (options.url) {
      webview.raw.bind("__sweetviewTabTitle", (t: unknown) => {
        if (typeof t === "string") api.setTitle(t);
      });
      webview.raw.init(FOLLOW_TITLE);
      onLoadFailed(nsWin, (reason) => webview.raw.setHTML(loadFailedPage(options.url!, reason)));
    }

    const afterRec = options.after ? tabRecordByApi.get(options.after) : undefined;
    if (host.visible) {
      record.shown = true;
      host.group.show(nsWin, afterRec?.nsWin, (w) => focusWebView(w));
      emitWindowTabSelect(window, api);
    } else {
      host.pendingShow.push({ nsWin, after: afterRec?.nsWin });
      host.selectedBeforeShow ??= nsWin;
    }
    return api;
  },

  mergeAllWindows(into?: Window) {
    const preferred = into ? hosts.get(into) : undefined;
    if (preferred) {
      preferred.group.mergeAllWindows();
      return;
    }
    for (const host of hosts.values()) {
      host.group.mergeAllWindows();
      break;
    }
  },

  disposeWindow(window: Window) {
    const host = hosts.get(window);
    if (host) disposeMacHost(host);
  },
};
