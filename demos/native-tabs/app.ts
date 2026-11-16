// Tabs with one webview per tab. A tab shows this demo's page or any site;
// the + in the tab bar, the keyboard and the page's own buttons open tabs.
//
// macOS: the system's own tab bar. Every tab is a separate NSWindow hosting a
// separate WKWebView, joined by AppKit's window tabbing (mac-tabs-app.ts).
// Windows: there is no window tabbing to borrow, so the window is ours. Its
// title bar is a tab strip, and every tab is a child window hosting a
// separate WebView2 (win-tabs-app.ts).
//
// The OS loop runs from Bun's event loop (`runEventLoop`) rather than the
// webview's blocking `run()`, so opening a tab, which awaits, works at any
// moment on this thread, and a closed tab's webview is disposed by itself.
//
//   just demos native-tabs app

import { runEventLoop } from "@n1h/sweetview/native";

if (process.platform !== "darwin" && process.platform !== "win32") {
  console.error(`native-tabs: macOS and Windows only; ${process.platform} has no backend in @n1h/sweetview/native.`);
  process.exit(1);
}

const loop = runEventLoop(); // first, so the pages below can load and answer while they open
// Imported here, not at the top: each module loads its platform's libraries as it is evaluated.
if (process.platform === "darwin") {
  const { startTabsApp } = await import("./mac-tabs-app");
  const app = startTabsApp();
  const first = await app.openTab();
  await app.openTab();
  await app.openTab("https://bun.sh");
  app.tabs.select(first);
} else {
  const { startTabsApp } = await import("./win-tabs-app");
  const app = await startTabsApp();
  let over = false;
  void loop.then(() => (over = true));
  try {
    const first = await app.openTab();
    await app.openTab();
    await app.openTab("https://bun.sh");
    app.select(first);
  } catch (err) {
    if (!over) throw err; // else the window was closed while its first tabs were still opening: the app has ended, and stays ended
  }
}

await loop; // until the last tab closes, or Quit
process.exit(0);
