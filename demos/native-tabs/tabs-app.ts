// The tabbed app, minus the event loop: the menus, the tab group, and what
// opening and closing a tab means. app.ts runs it; scripts/drive.ts runs it
// and then plays the user.
//
// A tab is three things made together and torn down together: an NSWindow
// (mac-window-tabs.ts), a webview hosted in it (createWebviewApp), and this
// module's record of it. Nothing is shared between tabs but the process.

import { createWebviewApp, indexHtml, type WebviewApp } from "@n1h/sweetview";
import { installAppMenu, quitEventLoop } from "@n1h/sweetview/native";
import pageCss from "./build/frontend/main.css" with { type: "file" };
import pageJs from "./build/frontend/main.js" with { type: "file" };
import { asWindowHandle, createWindowTabs, detachPage, installTabMenus, onLoadFailed, type WindowTabs } from "./mac-window-tabs";
import type { Events, Methods, TabInfo } from "./shared";
import { webAddress } from "./web-address";

export const APP_NAME = "Native Tabs";

export type Tab = {
  number: number;
  title: string;
  /** Set for a tab showing a site; a tab showing this demo's own page has none. */
  address?: string;
  /** Undefined until the webview exists, a few milliseconds after the window does. */
  app?: WebviewApp<Methods, Events>;
  /** The demo's page is up and listening for events; never true for a site. */
  listening: boolean;
};

export type TabsApp = {
  readonly tabs: WindowTabs;
  /** Open tabs by window, the ones still loading included. */
  readonly open: ReadonlyMap<bigint, Tab>;
  /**
   * Opens a tab after `base` (default: the tab the user is on) and resolves,
   * with its window, once it is in the tab bar. Tabs asked for in a row, before
   * the earlier ones have loaded, keep the order they were asked in.
   */
  openTab(address?: string, base?: bigint): Promise<bigint>;
};

const PAGE_BODY = `<main>
<p class="eyebrow">One webview per tab</p>
<h1><input id="title" aria-label="Tab title" spellcheck="false" autocomplete="off" /></h1>
<p class="lede">This tab is its own <code>WKWebView</code> inside its own <code>NSWindow</code>. macOS draws the tab bar. <span id="count"></span></p>
<dl class="proof">
<div><dt>Page instance</dt><dd id="instance"></dd></div>
<div><dt>Alive for</dt><dd id="alive"></dd></div>
<div><dt>Clicks in this tab</dt><dd id="clicks">0</dd></div>
</dl>
<div class="actions">
<button id="click" type="button">Click Me</button>
<button id="new" type="button" class="secondary">New Tab</button>
<button id="close" type="button" class="quiet">Close Tab</button>
</div>
<form id="open">
<label for="address">Open a site in a new tab</label>
<div class="row"><input id="address" value="bun.sh" spellcheck="false" autocomplete="off" autocapitalize="off" /><button type="submit" class="secondary">Open</button></div>
<p id="error" role="alert" hidden></p>
</form>
<p class="hint">Also try the <kbd>+</kbd> in the tab bar, <kbd>⌘T</kbd> and <kbd>⌘W</kbd>, dragging a tab out of the window, and Window › Merge All Windows.</p>
</main>`;

// Runs in a site's page at document start: the tab's title follows the site's.
const FOLLOW_TITLE = `(() => {
  let last;
  const report = () => {
    const title = document.title;
    if (title && title !== last && typeof window.__nativeTabsTitle === "function") window.__nativeTabsTitle((last = title));
  };
  new MutationObserver(report).observe(document, { subtree: true, childList: true, characterData: true });
  addEventListener("DOMContentLoaded", report);
  addEventListener("load", report);
})();`;

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** What a site tab shows when its site cannot be loaded: the address, the system's reason, and a way to try again. Titled with the host, so the tab keeps its name. */
const loadFailedPage = (address: string, reason: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(new URL(address).host)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 24px; box-sizing: border-box;
    font: 15px/1.55 -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; -webkit-font-smoothing: antialiased; }
  main { width: min(100%, 520px); }
  h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.01em; }
  p { margin: 0 0 10px; opacity: 0.72; }
  .address { opacity: 1; font: 14px ui-monospace, "SF Mono", Menlo, monospace; overflow-wrap: anywhere; }
  a { display: inline-block; margin-top: 10px; padding: 8px 16px; border-radius: 9px; background: AccentColor; color: AccentColorText; font-weight: 600; text-decoration: none; }
</style>
<main>
<h1>This site did not open</h1>
<p class="address">${escapeHtml(address)}</p>
<p>${escapeHtml(reason)}</p>
<a href="${escapeHtml(address)}">Try Again</a>
</main>
</html>`;

export function startTabsApp(): TabsApp {
  installAppMenu({ appName: APP_NAME, aboutText: "Every tab is its own NSWindow with its own WKWebView. AppKit's window tabbing puts them behind one tab bar." });
  installTabMenus();

  const open = new Map<bigint, Tab>();
  let opened = 0;
  // Tabs not yet in the tab bar: each settles when its tab is there, or has failed.
  const loading = new Map<bigint, Promise<void>>();
  // By the tab a new one was asked to follow: the newest tab asked to follow it.
  const newest = new Map<bigint | undefined, bigint>();

  const announce = () => {
    const count = tabs.count();
    for (const tab of open.values()) if (tab.listening) tab.app?.emit("tabs", { count });
  };

  const tabs = createWindowTabs({
    identifier: "dev.mrowr.native-tabs",
    width: 1040,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    onNewTabRequest: () => void openTab().catch(failed),
    onClosed(window) {
      const tab = open.get(window);
      open.delete(window);
      newest.delete(window);
      detachPage(window); // first: a call or reply still on its way must not reach a disposed webview
      tab?.app?.dispose();
      announce();
      if (open.size === 0) quitEventLoop(); // the last tab was the app; one still loading keeps it alive
    },
  });

  const failed = (err: unknown) => console.error("native-tabs: could not open a tab:", err instanceof Error ? err.message : err);

  const rename = (window: bigint, tab: Tab, title: string) => {
    tab.title = title.trim() || `Tab ${tab.number}`;
    tabs.setTitle(window, tab.title);
  };

  async function openTab(address?: string, base = tabs.current()): Promise<bigint> {
    const number = ++opened;
    const tab: Tab = { number, title: address === undefined ? `Tab ${number}` : new URL(address).host, address, listening: false };
    // Where it goes is settled now, not when the page has loaded: the user may have moved on by
    // then. Cmd+T three times in a row gives three tabs in that order, each after the one
    // before it, although none of them is in the tab bar yet when the next is asked for.
    const previous = newest.get(base);
    const after = previous !== undefined && loading.has(previous) ? previous : base;
    const window = tabs.createWindow(tab.title);
    newest.set(base, window);
    open.set(window, tab);

    const inTabBar = Promise.withResolvers<void>();
    loading.set(window, inTabBar.promise);
    const settled = () => {
      loading.delete(window);
      if (newest.get(base) === window) newest.delete(base);
      inTabBar.resolve();
    };
    let showing = false;
    const show = () => {
      if (showing) return;
      showing = true;
      void (async () => {
        if (after !== undefined) await loading.get(after); // the tab it follows goes in first
        if (!open.has(window)) return; // gave up meanwhile
        tabs.show(window, after);
        settled();
        announce();
      })();
    };

    try {
      tab.app = await createWebviewApp<Methods, Events>({
        title: tab.title,
        window: asWindowHandle(window),
        resizable: true,
        debug: process.env.WEBVIEW_DEBUG === "1",
        assets: { "index.html": indexHtml({ title: tab.title, body: PAGE_BODY }), "main.js": pageJs, "main.css": pageCss },
        // A site gets none of these: only this demo's own page may open, rename and close tabs.
        uiMethods:
          address !== undefined
            ? {}
            : {
                "tab.info": (): TabInfo => {
                  tab.listening = true;
                  show(); // the page has drawn itself: the tab appears already filled in
                  return { number: tab.number, title: tab.title, tabs: tabs.count() };
                },
                "tab.open": (to) => void openTab(to === null ? undefined : webAddress(to), window).catch(failed), // next to the tab that asked
                "tab.rename": (title) => rename(window, tab, title),
                "tab.close": () => tabs.close(window),
              },
      });
    } catch (err) {
      open.delete(window);
      tabs.discard(window);
      settled(); // whatever was to follow this tab goes where the user is instead
      throw err;
    }
    // The page can ask who it is before the line above has its answer, and events cannot reach
    // it until `tab.app` is set: tell it now what it missed.
    if (tab.listening) tab.app.emit("tabs", { count: tabs.count() });

    if (address !== undefined) {
      const { webview } = tab.app;
      webview.bind("__nativeTabsTitle", (title: unknown) => {
        if (typeof title === "string") rename(window, tab, title);
      });
      webview.init(FOLLOW_TITLE);
      onLoadFailed(window, (reason) => webview.setHTML(loadFailedPage(address, reason)));
      webview.navigate(address);
      show();
    } else {
      setTimeout(show, 1000); // a page that never asks still gets its tab
    }
    await inTabBar.promise;
    return window;
  }

  return { tabs, open, openTab };
}
