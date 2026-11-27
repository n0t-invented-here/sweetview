import { engineOf, Webview } from "../../src/webview";
import { native } from "./kit";
import * as probe from "./win32-probe";
const wv = new Webview(false, { width: 300, height: 200, hint: 0 });
const engine = engineOf(wv)!;
const keys: unknown[] = [];
engine.onAcceleratorKey((k) => { keys.push(k); return true; });
const fails: unknown[] = [];
engine.onNavigationFailed((url, reason) => { fails.push({ url, reason }); });
const opened: string[] = [];
engine.onNewWindowRequested((url) => opened.push(url));
wv.bind("ready", () => {
  const hwnd = wv.unsafeWindowHandle!;
  const target = probe.findDescendant(hwnd, "Chrome_RenderWidgetHostHWND");
  console.log("target", target);
  engine.moveFocus();
  native.scheduleTimeout(300, () => {
    console.log("fg", probe.takeForeground(hwnd), "tap", probe.tapKey(hwnd, 0x87));
    probe.postMessage(target, probe.WM_KEYUP, 0x78n, 0xC0430001n);
    engine.callDevToolsProtocolMethod("Input.dispatchKeyEvent", JSON.stringify({ type: "rawKeyDown", windowsVirtualKeyCode: 0x77, key: "F8", code: "F8" }));
    engine.callDevToolsProtocolMethod("Input.dispatchKeyEvent", JSON.stringify({ type: "keyUp", windowsVirtualKeyCode: 0x77, key: "F8", code: "F8" }));
    native.scheduleTimeout(800, () => { wv.eval("window.open('http://webview.localhost/popup')"); native.scheduleTimeout(500, () => wv.navigate("http://127.0.0.1:9/")); });
    native.scheduleTimeout(4000, () => native.quitLoop());
  });
});
wv.setHTML("<!doctype html><body>keys<script>window.ready()</script></body>");
wv.run();
console.log(JSON.stringify({ keys, fails, opened }));
process.exit(0);
