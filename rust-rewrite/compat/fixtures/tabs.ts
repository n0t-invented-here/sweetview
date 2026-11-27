// Part B rows of `@n1h/sweetview-native/win32/tab-window` and the `Tab`
// members that changed with tabs on the Rust frame, run for real: the frame is
// a `Window` made with `{ tabs: true }` and `getTabFrame` gives its tab side;
// the strip and the page are rectangles for child webviews; a close request
// reaches `Window.onClose`; `showTabPopupMenu` and `windowMenu` act on any
// window of this thread, as before the rewrite (a second process works each
// menu while this thread is inside it); and `tab.webview.window` wraps the
// frame while `tab.window` is the logical window. Prints one JSON line.

import { fileURLToPath } from "node:url";
import { WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview-native";
import { createChildWebview, engineOf, isWindowDisposed } from "@n1h/sweetview-native/internal";
import { getTabFrame, showTabPopupMenu, windowMenu } from "@n1h/sweetview-native/win32/tab-window";

const report: Record<string, unknown> = {};
const positive = (r: { width: number; height: number }) => r.width > 0 && r.height > 0;

const win = new Window({ tabs: true, title: "sweetview compat tabs", bounds: { x: 140, y: 140, width: 640, height: 420 }, noActivate: true });
const plain = new Window({ title: "sweetview compat plain" });

// createFrameWindow(opts) -> new Window({ tabs: true, ... }), then getTabFrame(BigInt(win.handle)).
const frame = getTabFrame(BigInt(win.handle!));
report.frameOfTabbedWindow = frame !== undefined && frame.hwnd === BigInt(win.handle!);
report.frameOfPlainWindow = getTabFrame(BigInt(plain.handle!)) === undefined;

// stripRect() is unchanged (the strip on the screen); stripBounds() and pageRect() are where child webviews go.
const strip = frame!.stripBounds();
const page = frame!.pageRect();
report.stripBoundsPositive = positive(strip);
report.pageBelowStrip = page.y >= strip.y + strip.height && positive(page);
report.stripRectOnScreen = positive(frame!.stripRect());
report.pageSizePositive = positive(frame!.pageSize());

// A pane is a child webview of the frame: made at pageRect(), placed, shown and hidden through its engine.
const child = createChildWebview(false, frame!.hwnd, page);
const engine = engineOf(child)!;
engine.setBounds({ ...page, height: Math.max(1, page.height - 10) });
engine.setVisible(false);
engine.setVisible(true);
report.childInFrame = BigInt(child.unsafeWindowHandle!) === frame!.hwnd;
child.destroy();

// showTabPopupMenu and windowMenu: any window of this thread, a tab frame or not. The probe reads the
// menu from a second process and chooses its first item or closes it.
const probe = fileURLToPath(new URL("../../../packages/sweetview/test/fixtures/win-menu-probe.ts", import.meta.url));
const workMenu = (action: string) => Bun.spawn([process.execPath, probe, String(process.pid), action], { stdout: "pipe", stderr: "pipe" });
let chosen = "";
const pick = workMenu("pick:0");
report.popupOnPlainWindow = showTabPopupMenu(BigInt(plain.handle!), [{ label: "One", click: () => (chosen = "one") }]);
await pick.exited;
report.popupClickRan = chosen === "one";
report.popupWithNoItems = showTabPopupMenu(frame!.hwnd, []);
const close = workMenu("close");
windowMenu(BigInt(plain.handle!));
await close.exited;
const systemMenu = JSON.parse((await new Response(close.stdout).text()).trim()) as { items?: { enabled?: boolean; separator?: boolean }[] };
// Restore, Move, Size, Minimize, Maximize, a separator, Close; Restore greyed on a window that is not maximised.
report.windowMenuOnPlainWindow = systemMenu.items?.map((item) => (item.separator ? "-" : item.enabled));

// FrameCallbacks.onCloseRequest -> Window.onClose: the frame's close request reaches the Window's listeners.
let closes = 0;
const offClose = win.onClose(() => closes++);
frame!.requestClose();
report.requestCloseReachesOnClose = closes === 1;
report.windowKeptByListener = !isWindowDisposed(win); // the listener took the request
offClose();

// tab.webview.window wraps the frame the tab opened in; tab.window is the logical window.
const tab = await WebView.openTab(win, { title: "compat", assets: { "index.html": new TextEncoder().encode("<!doctype html><title>compat</title>") } });
report.tabWindowIsLogical = tab.window === win;
report.tabWebviewWindowWrapsFrame = tab.webview.window !== win && BigInt(tab.webview.window.handle!) === frame!.hwnd;

win.dispose();
plain.dispose();
console.log(JSON.stringify(report));
process.exit(0);
