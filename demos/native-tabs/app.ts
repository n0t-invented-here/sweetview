// Native tabs with one webview per tab, on macOS: a window with the system's
// own tab bar, where every tab is a separate NSWindow hosting a separate
// WKWebView. The + in the tab bar, Cmd+T and the page's own buttons open
// tabs; a tab can show this demo's page or any site.
//
// The OS loop runs from Bun's event loop (`runEventLoop`) rather than the
// webview's blocking `run()`, so opening a tab, which awaits, works at any
// moment on this thread, and a closed tab's webview is disposed by itself.
//
//   just demos native-tabs app

import { runEventLoop } from "@n1h/sweetview/native";

if (process.platform !== "darwin") {
  console.error("native-tabs: macOS only so far. Window tabbing is an AppKit feature; Windows has nothing to map it onto yet.");
  process.exit(1);
}
// Imported here, not at the top: the module loads AppKit as it is evaluated.
const { startTabsApp } = await import("./tabs-app");

const loop = runEventLoop(); // first, so the pages below can load and answer while they open
const app = startTabsApp();
const first = await app.openTab();
await app.openTab();
await app.openTab("https://bun.sh");
app.tabs.select(first);

await loop; // until the last tab closes, or Quit
process.exit(0);
