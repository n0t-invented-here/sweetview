// Part C rows that changed behaviour, run against a real webview: the opaque
// `unsafeHandle` (accepted by the worker functions and by `new Webview(handle)`),
// the real `HWND` of `unsafeWindowHandle`, and `bindRaw`'s third argument as
// any value; destroy() as the one teardown, after which the handles are null
// and the checked calls throw code -3. Run with WEBVIEW_PATH set to a file that does not exist: it has
// no effect on Windows. Prints one JSON line.

import { Window, pumpEvents } from "@n1h/sweetview-native";
import { RawWebview as Webview, SizeHint, WebviewError, completeWebviewRequest, endWebviewResponse } from "@n1h/sweetview";

const report: Record<string, unknown> = { webviewPath: process.env.WEBVIEW_PATH };
const errorOf = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (err) {
    return err instanceof WebviewError ? `WebviewError ${err.fn} ${err.code}` : `${(err as Error).name}: ${(err as Error).message}`;
  }
};

const webview = new Webview(false, { width: 320, height: 240, hint: SizeHint.FIXED });
const handle = webview.unsafeHandle!;
report.handleType = typeof handle;
report.handleIsSafeInteger = Number.isSafeInteger(handle);

// The worker functions take the opaque number. A request id nobody is waiting on is a no-op.
report.completeUnknownRequest = errorOf(() => completeWebviewRequest(handle, 123456789n, { status: 204 }));
report.endUnknownResponse = errorOf(() => endWebviewResponse(handle, 123456789n));
// A number that names no live webview is refused.
const unknown = handle + 1_000_003;
report.completeOnUnknownHandle = errorOf(() => completeWebviewRequest(unknown, 1n, { status: 200 }));
report.wrapUnknownHandle = errorOf(() => new Webview(unknown));

// new Webview(handle) wraps the live webview, and leaves its window's size alone
// (the bindings package's constructor set the default 1024x768 on it).
const sizeBefore = Window.fromHandle(webview.unsafeWindowHandle!);
const boundsBefore = sizeBefore.bounds();
const wrapped = new Webview(handle);
report.wrapSameHandle = wrapped.unsafeHandle === handle;
report.wrapKeepsSize = JSON.stringify(sizeBefore.bounds()) === JSON.stringify(boundsBefore);
sizeBefore.dispose();

// unsafeWindowHandle is the real HWND: Window.fromHandle accepts it (a non-window throws).
const hwnd = webview.unsafeWindowHandle!;
report.windowHandleType = typeof hwnd;
const win = Window.fromHandle(hwnd);
const bounds = win.bounds();
report.windowBoundsPositive = bounds.width > 0 && bounds.height > 0;
win.dispose();

// bindRaw's third argument is any value, handed back as it is.
const arg = { token: "compat" };
let seen: { same: boolean; req: string } | undefined;
webview.bindRaw(
  "compatRaw",
  (seq, req, a) => {
    seen = { same: a === arg, req };
    webview.return(seq, 0, "null");
  },
  arg,
);
webview.setHTML("<!doctype html><script>window.compatRaw(1, 'two');</script>");
const until = Date.now() + 20_000;
while (!seen && Date.now() < until) {
  pumpEvents();
  await Bun.sleep(5);
}
report.bindRaw = seen ?? "the page never called the binding";

webview.destroy();
report.handleAfterDestroy = webview.unsafeHandle;
report.completeAfterDestroy = errorOf(() => completeWebviewRequest(handle, 1n, {}));
report.windowHandleAfterDestroy = webview.unsafeWindowHandle;
report.setRequestHandlerAfterDestroy = errorOf(() => webview.setRequestHandler(null));
report.destroyTwice = errorOf(() => webview.destroy());
console.log(JSON.stringify(report));
process.exit(0);
