// Platform selector for built-in native tabs. Imported by src/index.ts to
// register the TabsDriver with WebView.openTab / createApp({ tabs: true }).

import { registerTabsDriver, type TabsDriver } from "../app";
import type { EventMap, MethodMap } from "../ipc";
import type { Tab, TabOptions } from "../app";
import type { Window } from "../native/window";

let cached: TabsDriver | undefined;
function driver(): TabsDriver {
  if (cached) return cached;
  if (process.platform === "win32") {
    cached = (require("./win-tabs") as { winTabsDriver: TabsDriver }).winTabsDriver;
  } else if (process.platform === "darwin") {
    cached = (require("./darwin-tabs") as { darwinTabsDriver: TabsDriver }).darwinTabsDriver;
  } else {
    throw new Error(`sweetview: native tabs are not supported on ${process.platform} (win32 and darwin only)`);
  }
  return cached;
}

registerTabsDriver({
  openTab<M extends MethodMap, E extends EventMap>(window: Window, options: TabOptions<M>): Promise<Tab<M, E>> {
    return driver().openTab(window, options);
  },
  mergeAllWindows(into?: Window) {
    driver().mergeAllWindows(into);
  },
  disposeWindow(window: Window) {
    if (cached) cached.disposeWindow(window);
  },
});
