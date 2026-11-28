// Tabs with one webview per tab, built on @n1h/sweetview's built-in native tabs API.
// macOS uses AppKit window tabbing; Windows uses a captionless frame with a built-in
// tab strip, and every tab a child WebView2 of that frame.
//
//   just demos native-tabs app

import { createApp, indexHtml, WebView, type App, type Tab, type TabOptions } from "@n1h/sweetview";
import { dotIco, setAppMenu, type Icon, type Window } from "@n1h/sweetview/native";
import pageCss from "./build/frontend/main.css" with { type: "file" };
import pageJs from "./build/frontend/main.js" with { type: "file" };
import type { Events, Methods, TabInfo } from "./shared";
import { tabPageBody } from "./tab-page";
import { displayHost, webAddress } from "./web-address";

const APP_NAME = "Native Tabs";
const APP_ICON: Icon = { windows: { ico: dotIco({ color: "#6d5df6", sizes: [16, 24, 32, 48] }) } };

const PAGE_BODY = tabPageBody({
  lede:
    process.platform === "darwin"
      ? "This tab is its own <code>WKWebView</code> inside its own <code>NSWindow</code>. macOS draws the tab bar."
      : "This tab is its own <code>WebView2</code>, a child of the window. The tab strip above is built into sweetview.",
  hint:
    process.platform === "darwin"
      ? "Try the <kbd>+</kbd> in the tab bar, <kbd>⌘T</kbd> and <kbd>⌘W</kbd>, dragging a tab out of the window, and Window › Merge All Windows."
      : "Try the <kbd>+</kbd> in the tab strip, <kbd>Ctrl</kbd>+<kbd>T</kbd>, <kbd>Ctrl</kbd>+<kbd>W</kbd>, <kbd>Ctrl</kbd>+<kbd>Tab</kbd>, dragging tabs to reorder or detach, and right-clicking a tab.",
});

export type DemoTabsController = {
  readonly app: App<Methods, Events>;
  readonly openTabs: ReadonlyMap<number, Tab<Methods, Events>>;
  /**
   * Opens in `after`'s window when given, else in `into`, else in the app window. With `reveal`,
   * a hidden window is shown once the tab's page is ready (showOnReady), never before it has painted.
   */
  openTab(address?: string, after?: Tab<Methods, Events>, into?: Window, reveal?: boolean): Promise<Tab<Methods, Events>>;
};

export async function startDemoTabs(): Promise<DemoTabsController> {
  if (process.platform === "darwin") {
    setAppMenu({
      appName: APP_NAME,
      aboutText: "Every tab is its own NSWindow with its own WKWebView. AppKit's window tabbing puts them behind one tab bar.",
    });
  }

  const openTabs = new Map<number, Tab<Methods, Events>>();
  let nextNum = 0;

  const announce = () => {
    for (const tab of openTabs.values()) tab.webview.emit("tabs", { count: openTabs.size });
  };

  const app = await createApp<Methods, Events>({
    title: APP_NAME,
    icon: APP_ICON,
    tabs: true,
    // A torn-off window's + and Ctrl+T open the tab there, not in the first window.
    onNewTab: (origin) => void openTab(undefined, undefined, origin).catch((err) => console.error("native-tabs:", err)),
    onTabClose: (closed) => {
      for (const [id, t] of openTabs) {
        if (t === closed) openTabs.delete(id);
      }
      announce();
      if (openTabs.size === 0) app.quit();
    },
    onClose: () => app.quit(),
  });

  async function openTab(address?: string, after?: Tab<Methods, Events>, into?: Window, reveal = false): Promise<Tab<Methods, Events>> {
    const number = ++nextNum;
    const title = address ? displayHost(address) : `Tab ${number}`;
    const target = after?.window ?? into ?? app.window;
    const open = (options: TabOptions<Methods>) =>
      target === app.window ? app.openTab<Methods, Events>(options) : WebView.openTab<Methods, Events>(target, options);
    if (address) {
      const tab = await open({ title, url: address, after, debug: process.env.WEBVIEW_DEBUG === "1" });
      openTabs.set(number, tab);
      announce();
      return tab;
    }

    let created!: Tab<Methods, Events>;
    created = await open({
      title,
      after,
      debug: process.env.WEBVIEW_DEBUG === "1",
      assets: { "index.html": indexHtml({ title, body: PAGE_BODY }), "main.js": pageJs, "main.css": pageCss },
      showOnReady: reveal,
      readyTimeoutMs: reveal ? 15_000 : undefined,
      uiMethods: {
        "tab.info": (): TabInfo => ({ number, title: created?.title ?? title, tabs: openTabs.size }),
        "tab.open": (to) => {
          const target = to === null ? undefined : webAddress(to);
          void openTab(target, created).catch((err) => console.error("native-tabs:", err));
        },
        "tab.rename": (nextTitle) => created.setTitle(nextTitle),
        "tab.close": () => created.close(),
      },
    });
    openTabs.set(number, created);
    announce();
    return created;
  }

  return { app, openTabs, openTab };
}

if (import.meta.main) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    console.error(`native-tabs: macOS and Windows only; ${process.platform} has no backend in @n1h/sweetview/native.`);
    process.exit(1);
  }
  const demo = await startDemoTabs();
  const loop = demo.app.run();
  try {
    // The window shows itself once the first tab's page is ready.
    const first = await demo.openTab(undefined, undefined, undefined, true);
    await demo.openTab();
    await demo.openTab("https://bun.sh");
    first.select();
  } catch (err) {
    // Without a window to close, the loop would never end.
    console.error("native-tabs:", err);
    process.exitCode = 1;
    demo.app.quit();
  }
  await loop;
  // Until the macOS goal of the Rust rewrite, macOS runs the code it ran at the tag pre-rust-rewrite,
  // which releases nothing at exit: there the demo tears down and exits as it did then.
  if (process.platform === "darwin") {
    demo.app.dispose();
    process.exit();
  }
}
