import { Webview } from "../../src/webview";
import * as probe from "./win32-probe";
const u = new Webview(false, undefined);
const h = u.unsafeWindowHandle!;
console.log("visible", probe.isVisible(h), probe.clientSize(h), probe.windowRect(h), probe.dpi(h), probe.style(h).toString(16));
u.destroy();
console.log("after destroy isWindow", probe.isWindow(h));
process.exit(0);
