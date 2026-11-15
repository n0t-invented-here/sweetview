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
import { asWindowHandle, createWindowTabs, detachPage, installTabMenus, type WindowTabs } from "./mac-window-tabs";
import type { Events, Methods, TabInfo } from "./shared";

export const APP_NAME = "Native Tabs";

export type Tab = {
  number: number;
  title: string;
  /** Set for a tab showing a site; a tab showing this demo's own page has none. */
  address?: string;
  /** Undefined until the webview exists, a few milliseconds after the window does. */
  app?: WebviewApp<Methods, Events>;
};

export type TabsApp = {
  readonly tabs: WindowTabs;
  /** Open tabs by window, the ones still loading included. */
  readonly open: ReadonlyMap<bigint, Tab>;
  /** Opens a tab after `after` (default: the tab the user is on) and resolves, with its window, once it is in the tab bar. */
  openTab(address?: string, after?: bigint): Promise<bigint>;
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

/** "bun.sh" -> "https://bun.sh/". Throws on anything that is not an http or https address. */
export function webAddress(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Type a web address first.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`"${trimmed}" is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https addresses open in a tab, not ${url.protocol}//`);
  return url.href;
}

export function startTabsApp(): TabsApp {
  installAppMenu({ appName: APP_NAME, aboutText: "Every tab is its own NSWindow with its own WKWebView. AppKit's window tabbing puts them behind one tab bar." });
  installTabMenus();

  const open = new Map<bigint, Tab>();
  let opened = 0;

  const announce = () => {
    const count = tabs.count();
    for (const tab of open.values()) tab.app?.emit("tabs", { count });
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
      detachPage(window); // first: a call or reply still on its way must not reach a disposed webview
      tab?.app?.dispose();
      announce();
      if (tabs.count() === 0) quitEventLoop(); // the last tab was the app
    },
  });

  const failed = (err: unknown) => console.error("native-tabs: could not open a tab:", err instanceof Error ? err.message : err);

  const rename = (window: bigint, tab: Tab, title: string) => {
    tab.title = title.trim() || `Tab ${tab.number}`;
    tabs.setTitle(window, tab.title);
  };

  // `after` is settled now, not when the page has loaded: the user may have moved on by then.
  async function openTab(address?: string, after = tabs.current()): Promise<bigint> {
    const number = ++opened;
    const tab: Tab = { number, title: address === undefined ? `Tab ${number}` : new URL(address).host, address };
    const window = tabs.createWindow(tab.title);
    open.set(window, tab);

    const inTabBar = Promise.withResolvers<void>();
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      tabs.show(window, after);
      announce();
      inTabBar.resolve();
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
      throw err;
    }

    if (address !== undefined) {
      tab.app.webview.bind("__nativeTabsTitle", (title: unknown) => {
        if (typeof title === "string") rename(window, tab, title);
      });
      tab.app.webview.init(FOLLOW_TITLE);
      tab.app.webview.navigate(address);
      show();
    } else {
      setTimeout(show, 1000); // a page that never asks still gets its tab
    }
    await inTabBar.promise;
    return window;
  }

  return { tabs, open, openTab };
}
