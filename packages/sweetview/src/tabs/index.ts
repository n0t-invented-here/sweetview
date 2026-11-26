// Platform selector for built-in native tabs. Imported by src/index.ts to
// register the TabsDriver with WebView.openTab / createApp({ tabs: true }).
// Uses dynamic import() rather than require() so `bun build --compile` works
// cleanly with the top-level await inside @n1h/sweetview-webview-bun.

import { registerTabsDriver, type Tab, type TabOptions, type TabsDriver } from "../app";
import type { EventMap, MethodMap } from "@n1h/sweetview-ipc";
import type { Window } from "@n1h/sweetview-native";

let cached: TabsDriver | undefined;
let loading: Promise<TabsDriver> | undefined;

async function driver(): Promise<TabsDriver> {
  if (cached) return cached;
  if (!loading) {
    loading = (async () => {
      if (process.platform === "win32") {
        cached = (await import("./win-tabs")).winTabsDriver;
      } else if (process.platform === "darwin") {
        cached = (await import("./darwin-tabs")).darwinTabsDriver;
      } else {
        throw new Error(`sweetview: native tabs are not supported on ${process.platform} (win32 and darwin only)`);
      }
      return cached;
    })();
  }
  return loading;
}

registerTabsDriver({
  async openTab<M extends MethodMap, E extends EventMap>(window: Window, options: TabOptions<M>): Promise<Tab<M, E>> {
    return (await driver()).openTab<M, E>(window, options);
  },
  mergeAllWindows(into?: Window) {
    cached?.mergeAllWindows(into);
  },
  disposeWindow(window: Window) {
    cached?.disposeWindow(window);
  },
});
