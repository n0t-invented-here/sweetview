import { join } from "node:path";
import { WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { scheduleNativeTimeout } from "../../../sweetview-native/src/internal";
import { controllerOf, devTools } from "../../src/tabs/win-webview2";

const path = join(process.env.WEBVIEW2_USER_DATA_FOLDER!, "dropped ü.txt");
await Bun.write(path, "file drop fixture");
const win = new Window({ title: "WebView2 file drop test" });
const states: boolean[] = [];
let delivered: string[] | undefined;
let timedOut = false;
let off = win.onFileDrop(() => {});

const view = await WebView.attach<{ advance: [boolean, void] }>(win, {
  assets: {
    "index.html": new Blob([`<!doctype html><html><body>Drop target<script>
      (async () => {
        for (const expected of [true, true, false, true]) {
          while (window.__webview_file_drop_enabled__ !== expected) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          await window.__sweetview_rpc("advance", expected);
        }
      })();
    </script></body></html>`]),
  },
  uiMethods: {
    advance(enabled) {
      states.push(enabled);
      switch (states.length) {
        case 1: {
          const second = win.onFileDrop(() => {});
          off();
          off = second;
          break;
        }
        case 2:
          off();
          break;
        case 3:
          off = win.onFileDrop((paths) => {
            delivered = paths;
            view.quit();
          });
          break;
        case 4: {
          const controller = controllerOf(view.raw);
          // Drive Chromium through WebView2's DevTools protocol. Attaching a
          // real file lets WebView2 return its path through ICoreWebView2File.
          const data = { items: [], files: [path], dragOperationsMask: 1 };
          for (const type of ["dragEnter", "dragOver", "drop"]) {
            devTools(controller, "Input.dispatchDragEvent", { type, x: 20, y: 20, data });
          }
          break;
        }
      }
    },
  },
});

const stopTimer = scheduleNativeTimeout(8000, () => {
  timedOut = true;
  view.quit();
});
try {
  win.show();
  view.run(); // Destroys the view with its final drop listener still installed.
  off();
  win.onFileDrop(() => {})();
  console.log("RESULT " + JSON.stringify({ timedOut, report: { states, delivered, path, disposed: view.raw.unsafeHandle === null } }));
} finally {
  stopTimer();
  view.dispose();
  win.dispose();
}
