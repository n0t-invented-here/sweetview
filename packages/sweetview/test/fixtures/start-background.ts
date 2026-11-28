// What a webview attached to a window with a backgroundColor shows behind a page that paints
// nothing but a stripe, read from the screen, in a process of its own so its environment
// (WEBVIEW2_DEFAULT_BACKGROUND_COLOR, which WebView2 reads when it starts) is the test's to set.
// Prints `RESULT <json>`: { mark, below } once the stripe shows, or what was last seen.
// With the argument `no-colour`, the window has no backgroundColor.

import { WebView } from "../../src/index";
import { Window, pumpEvents } from "@n1h/sweetview-native";
import { scheduleNativeTimeout } from "../../../sweetview-native/src/internal";
import { clientSize, clientToScreen, screenPixel } from "../../../sweetview-native/test/win32-os";

const MARK = "#ff00ff";
const backgroundColor = process.argv[2] === "no-colour" ? undefined : "#304050";
const win = new Window({ title: "start background fixture", backgroundColor, topmost: true, noActivate: true, bounds: { x: 160, y: 160, width: 360, height: 260 } });
win.show();
const hwnd = BigInt(win.handle!);
// While the webview starts: the middle of the page area, from native timers (they fire inside the loops WebView2 pumps).
const during = new Set<string>();
let sampling = true;
const sample = () => {
  if (!sampling) return;
  const size = clientSize(hwnd);
  const at = clientToScreen(hwnd, size.width >> 1, size.height >> 1);
  during.add(screenPixel(at.x, at.y));
  scheduleNativeTimeout(2, sample);
};
const fadeIn = performance.now() + 400;
while (performance.now() < fadeIn) {
  pumpEvents();
  Bun.sleepSync(10);
}
sample();
let loaded = false;
const view = await WebView.attach(win, {
  assets: {
    "index.html": new TextEncoder().encode(
      `<style>html,body{background:transparent;margin:0}#m{height:16px;background:${MARK}}</style><div id="m"></div><script>window.__sweetview_rpc("loaded", null)</script>`,
    ),
  },
  uiMethods: { loaded: () => void (loaded = true) },
});
let seen = { mark: "", below: "" };
const deadline = performance.now() + 15_000;
while (performance.now() < deadline) {
  pumpEvents();
  const size = clientSize(hwnd);
  const mark = clientToScreen(hwnd, size.width >> 1, 8);
  const below = clientToScreen(hwnd, size.width >> 1, size.height >> 1);
  seen = { mark: screenPixel(mark.x, mark.y), below: screenPixel(below.x, below.y) };
  if (loaded && seen.mark === MARK && seen.below !== "#304050" && seen.below !== "") {
    // Let it settle: the reading that stays is the one reported.
    Bun.sleepSync(200);
    pumpEvents();
    seen = { mark: screenPixel(mark.x, mark.y), below: screenPixel(below.x, below.y) };
    break;
  }
  if (loaded && seen.mark === MARK && seen.below === "#304050") break;
  Bun.sleepSync(20);
}
sampling = false;
view.dispose();
win.dispose();
console.log(`RESULT ${JSON.stringify({ ...seen, during: [...during] })}`);
process.exit(0);
