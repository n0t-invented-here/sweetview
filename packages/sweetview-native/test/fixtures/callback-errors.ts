// `onCallbackError` (src/callback-errors.ts) beside the W1.3 tests of src/callbacks.test.ts: with
// a listener set, an exception from each kind of callback the native module calls arrives at the
// listener exactly once, with its kind and the error the handler threw, Sweetview prints nothing
// (neither its `console.error` line nor the binding's stderr line), and the callback's fallback
// still applies. Run by src/callbacks.test.ts in a process of its own; prints `RESULT <json>`.
//
//   bun callback-errors.ts listener        every kind with a listener; then a listener that throws,
//                                          a thrown non-error, the binding's sink path, and the
//                                          default lines back once the listener is removed
//   bun callback-errors.ts exit-blocking   the listener calls process.exit(3) from inside a native
//                                          timeout while the blocking loop runs
//   bun callback-errors.ts exit-pumped     the same while a Bun timer pumps the loop (runEventLoop)
//
// Inputs are messages posted or sent to this process's own windows (the tray icon's window, the
// open menu's window, a window of its own, the single-instance window) and the toast events the
// notifier's test hooks deliver. Nothing is injected: the hook and refiner kinds need real input
// and are tested in callbacks.test.ts, through the real binding.

import { onCallbackError, type CallbackErrorSource } from "../../src/callback-errors";
import { quitEventLoop, runEventLoop, scheduleNativeTimeout } from "../../src/event-loop";
import { onOpenUrl, signalReady, singleInstance } from "../../src/activation";
import { Tray } from "../../src/tray";
import { deferNative, openNativeDrain, runNativeLoop, quitNativeLoop, wakeNative } from "../../src/ui-thread";
import { emitWindowNewTab, emitWindowTabClose, emitWindowTabSelect, onWindowDispose, Window } from "../../src/window";
import { createNotifier, debugNativeNotifier } from "../../src/win32/notifier";
import { currentTray } from "../../src/win32/tray";
import { TRAY, VK, WM_CLOSE, doubleClickTime, handOffToInstance, isWindow, openPopupMenu, postTrayMouse, pressKeys, sendDrop, user32 } from "../win32-os";
import { native, report, finish, watchdog } from "./kit";
import { windowChromeEvents } from "../../../sweetview/src/window-chrome";

const mode = process.argv[2] ?? "listener";
watchdog(mode === "listener" ? 80_000 : 30_000);

type Arrival = { kind: string; name?: string; message: string; isError: boolean; cause?: unknown };
const arrivals: Arrival[] = [];
const record = (error: Error, source: CallbackErrorSource) =>
  void arrivals.push({ kind: source.kind, ...(source.name === undefined ? {} : { name: source.name }), message: error.message, isError: error instanceof Error, ...(error.cause === undefined ? {} : { cause: error.cause }) });

// What Sweetview hands console.error, to show it prints nothing while a listener is set.
const printed: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => void printed.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));

async function pumpUntil(done: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    native.pumpEvents();
    await Bun.sleep(5);
  }
  native.pumpEvents();
  return done();
}
const pumpFor = (ms: number) => pumpUntil(() => false, ms);
const boom = (what: string) => () => {
  throw new Error(`${what} boom`);
};

if (mode === "exit-blocking" || mode === "exit-pumped" || mode === "exit-run-event-loop") {
  // Things the end of the application releases (D36), alive when the listener exits.
  const win = new Window({ title: "callback-errors exit", noActivate: true });
  const tray = new Tray({ tooltip: `callback-errors exit ${process.pid}` });
  void win;
  void tray;
  onCallbackError(() => {
    console.error = originalError;
    process.exit(3);
  });
  scheduleNativeTimeout(50, boom("exit timeout"));
  if (mode === "exit-blocking") {
    native.scheduleTimeout(10_000, () => quitNativeLoop());
    runNativeLoop();
  } else if (mode === "exit-run-event-loop") {
    // The public loop on a Bun timer, as an application without a webview runs it.
    setTimeout(() => quitEventLoop(), 10_000);
    await runEventLoop();
  } else {
    await pumpFor(10_000);
  }
  console.error = originalError;
  console.log("RESULT " + JSON.stringify({ exitedFromListener: false }));
  process.exit(0);
}

if (mode === "registration") {
  // Registering a listener reads nothing from the application's function, and no function names its
  // own kind (review 2, item 3).
  const win = new Window({ title: "callback-errors registration", bounds: { x: 160, y: 160, width: 320, height: 240 }, noActivate: true });
  let reads = 0;
  const counted = new Proxy(() => {}, {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const offClose = win.onClose(counted);
  const offMove = win.onMove(counted);
  offClose();
  offMove();
  const claiming = () => {
    throw new Error("claims another kind");
  };
  Object.defineProperty(claiming, Symbol.for("sweetview.callbackKind"), { value: "windowChromeEvents" });
  const told: string[] = [];
  const offTold = onCallbackError((error, source) => void told.push(`${source.kind}: ${error.message}`));
  const offResize = win.onResize(claiming);
  win.setBounds({ x: 160, y: 160, width: 340, height: 240 });
  await pumpFor(100);
  offResize();
  offTold();
  win.dispose();
  console.error = originalError;
  console.log("RESULT " + JSON.stringify({ readsWhileRegistering: reads, told }));
  process.exit(0);
}

if (mode === "reentry") {
  // A listener that calls back into Sweetview (review N6): it resizes a window whose onResize throws.
  const win = new Window({ title: "callback-errors reentry", bounds: { x: 150, y: 150, width: 320, height: 240 }, noActivate: true });
  let size = 320;
  win.onResize(boom("resize"));
  let calls = 0;
  const offReentry = onCallbackError(() => {
    calls++;
    if (calls > 50) return; // a bound for the test only: without the fix it recurses until the stack overflows
    size += 10;
    win.setBounds({ x: 150, y: 150, width: size, height: 240 });
  });
  win.setBounds({ x: 150, y: 150, width: 300, height: 240 });
  await pumpFor(200);
  offReentry();
  win.dispose();
  const result = { calls, printed: printed.splice(0) };
  console.error = originalError;
  console.log("RESULT " + JSON.stringify(result));
  process.exit(0);
}

if (mode === "chrome") {
  // windowChromeEvents (review F3): the kind belongs to its registration; what the page view throws is never touched.
  const win = new Window({ title: "callback-errors chrome", bounds: { x: 140, y: 140, width: 320, height: 240 }, noActivate: true });
  win.show();
  let thrown: unknown;
  const view = { emit: () => { throw thrown; } };
  const offChrome = windowChromeEvents(win, view);
  const maximizeOnce = async () => {
    const before = win.isMaximized();
    win.toggleMaximize();
    await pumpUntil(() => win.isMaximized() !== before, 3000);
    await pumpFor(50);
  };
  const result: Record<string, unknown> = {};
  // No listener: a frozen error is printed as itself.
  thrown = Object.freeze(new Error("frozen without listener"));
  await maximizeOnce();
  result.printedWithoutListener = printed.splice(0);
  // A listener: a primitive and a frozen error arrive with the kind; the frozen one is the same object.
  const told: { kind: string; message: string; same: boolean }[] = [];
  const offTold = onCallbackError((error, source) => void told.push({ kind: source.kind, message: error.message, same: error === thrown }));
  thrown = "chrome primitive";
  await maximizeOnce();
  thrown = Object.freeze(new Error("frozen with listener"));
  await maximizeOnce();
  // The same mutable error, thrown by the chrome and then by a deferred job: each with its own kind.
  thrown = new Error("thrown twice");
  await maximizeOnce();
  const again = thrown;
  deferNative(() => {
    throw again;
  });
  await pumpFor(100);
  offTold();
  offChrome();
  win.dispose();
  result.told = told.map(({ kind, message, same }) => `${kind}: ${message}${same ? "" : " (not the thrown value)"}`);
  result.printedWithListener = printed.splice(0);
  console.error = originalError;
  console.log("RESULT " + JSON.stringify(result));
  process.exit(0);
}

const off = onCallbackError(record);
const steps: Record<string, unknown> = {};

// deferred, timeout, interval (no TypeScript wrapper: the binding's sink), worker (the drain).
deferNative(boom("deferred"));
scheduleNativeTimeout(1, boom("timeout"));
let intervalRuns = 0;
const interval = native.scheduleInterval(5, () => {
  intervalRuns++;
  if (intervalRuns === 1) throw new Error("interval boom");
});
const drain = openNativeDrain(boom("drain"));
wakeNative(drain.token);
await pumpUntil(() => arrivals.length >= 4 && intervalRuns >= 3);
native.cancelTimeout(interval);
drain.close();
steps.intervalKeptItsSchedule = intervalRuns >= 3;

// Window listeners: a close request with a listener that throws is still taken (the window stays).
const win = new Window({ title: "callback-errors", bounds: { x: 120, y: 120, width: 320, height: 240 }, noActivate: true });
const hwnd = BigInt(win.handle!);
const offResize = win.onResize(boom("onResize"));
const offMove = win.onMove(boom("onMove"));
win.onClose(boom("onClose"));
win.onFileDrop(boom("onFileDrop"));
win.setBounds({ x: 130, y: 130, width: 330, height: 250 }); // moves and resizes: one onMove, one onResize
await pumpFor(100);
user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
steps.closeRequestStillTaken = isWindow(hwnd);
sendDrop(hwnd, ["C:\\callback-errors.txt"]);
await pumpUntil(() => arrivals.some((a) => a.kind === "window.onFileDrop"));
win.onNewTab(boom("onNewTab"));
win.onTabSelect(boom("onTabSelect"));
win.onTabClose(boom("onTabClose"));
emitWindowNewTab(win);
emitWindowTabSelect(win, { title: "t", setTitle() {}, select() {}, close() {}, dispose() {} });
emitWindowTabClose(win, { title: "t", setTitle() {}, select() {}, close() {}, dispose() {} });
// One maximise: an onMaximizeChange listener, and the one windowChromeEvents installs, each throw once.
offResize(); // the maximise below moves and resizes the window: those kinds arrived once above
offMove();
const offMaximize = win.onMaximizeChange(boom("onMaximizeChange"));
const offChrome = windowChromeEvents(win, { emit: boom("window chrome emit") });
win.show(); // noActivate: shown without taking the foreground
win.toggleMaximize();
// Both arrive as window.onMaximizeChange (review 3, Q3: the wait is for what the code produces).
const maximized = (message: string) => arrivals.some((a) => a.kind === "window.onMaximizeChange" && a.message === message);
await pumpUntil(() => maximized("onMaximizeChange boom") && maximized("window chrome emit boom"));
offMaximize();
offChrome();
win.toggleMaximize();
await pumpFor(100);
onWindowDispose(win, boom("dispose hook"));

// The refiner and the hooks need the pointer and the keyboard: their tests are in callbacks.test.ts,
// through the real binding with real input (review N8).
win.dispose();

// The tray: a click, a double click, a menu function that throws (no menu opens), a menu item.
const tray = new Tray({ tooltip: `callback-errors ${process.pid}`, onClick: boom("tray click"), onDoubleClick: boom("tray double click"), menu: boom("tray menu") });
const trayWindow = currentTray()!.windowHandle();
postTrayMouse(trayWindow, TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
await pumpUntil(() => arrivals.some((a) => a.kind === "tray.onClick"), doubleClickTime() + 2000);
postTrayMouse(trayWindow, TRAY.LBUTTONDBLCLK);
await pumpUntil(() => arrivals.some((a) => a.kind === "tray.onDoubleClick"), doubleClickTime() + 2000);
postTrayMouse(trayWindow, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
await pumpUntil(() => arrivals.some((a) => a.kind === "tray.menu"));
await pumpFor(300);
steps.throwingMenuOpensNoMenu = openPopupMenu() === 0n;
tray.dispose();

let itemChosen = false;
const menuTray = new Tray({ tooltip: `callback-errors menu ${process.pid}`, menu: () => [{ label: "Boom", click: () => ((itemChosen = true), boom("menu item")()) }] });
const menuTrayWindow = currentTray()!.windowHandle();
for (let attempt = 1; attempt <= 3 && !itemChosen; attempt++) {
  const watcher = native.scheduleInterval(10, () => {
    const menu = openPopupMenu();
    if (menu === 0n) return;
    native.cancelTimeout(watcher);
    pressKeys(menu, VK.DOWN, VK.RETURN);
  });
  postTrayMouse(menuTrayWindow, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
  await pumpUntil(() => itemChosen, 3000);
  native.cancelTimeout(watcher);
  await pumpUntil(() => openPopupMenu() === 0n, 1000);
}
menuTray.dispose();

// A notification click, through the notifier's own test hooks, under a throwaway app id.
const appId = `Sweetview.NotifierTest.${crypto.randomUUID()}`;
try {
  const notifier = createNotifier({ appId, onClick: boom("notification click") });
  const held = debugNativeNotifier(notifier)!;
  held.debugForcePath("toastHeld");
  const shown = held.debugShow("callback-errors", "t", "b", true, null);
  held.debugSimulateToastEvent(Number(String(shown).split(":")[1]), "activated");
  await pumpUntil(() => arrivals.some((a) => a.kind === "notifier.onClick"));
  notifier.dispose();
} finally {
  for (const key of [`HKCU\\Software\\Classes\\AppUserModelId\\${appId}`, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId}`]) {
    Bun.spawnSync(["reg", "delete", key, "/f"], { stdout: "pipe", stderr: "pipe" });
  }
}

// A second instance's handoff: its onSecondInstance handler and an onOpenUrl listener.
onOpenUrl(boom("open url"));
signalReady();
const lockId = `dev.sweetview.test.callback-errors-${process.pid}-${Date.now()}`;
const lock = await singleInstance({ appId: lockId, args: [], onSecondInstance: boom("second instance") });
steps.handedOff = handOffToInstance(lockId, { args: ["svtest://one"], cwd: "C:\\", url: "svtest://one" });
lock.dispose();

report.arrivals = arrivals.splice(0);
report.printedWithListener = printed.splice(0);
report.steps = steps;

// A listener that throws: both errors are printed, and the next listener still hears of it.
const others: string[] = [];
const offThrowing = onCallbackError(() => {
  throw new Error("listener boom");
});
const offOther = onCallbackError((error, source) => void others.push(`${source.kind}: ${error.message}`));
deferNative(boom("deferred again"));
await pumpFor(100);
offThrowing();
offOther();
report.throwingListener = { printed: printed.splice(0), nextListener: others, recorded: arrivals.splice(0).map((a) => `${a.kind}: ${a.message}`) };

// A thrown non-error arrives as an Error, with the value as its cause.
deferNative(() => {
  throw "a string";
});
await pumpFor(100);
report.nonError = arrivals.splice(0);

// The binding's sink itself throwing (straight through the binding, no TypeScript in between):
// the binding prints both lines on stderr. Then Sweetview's sink is put back.
native.setCallbackErrorSink(() => {
  throw new Error("raw sink boom");
});
const rawInterval = native.scheduleInterval(5, () => {
  native.cancelTimeout(rawInterval);
  throw new Error("raw interval boom");
});
await pumpFor(100);
native.setCallbackErrorSink(null);
off();

// No listener left: today's lines again, on console.error and, from the binding, on stderr.
deferNative(boom("deferred without listener"));
const lastInterval = native.scheduleInterval(5, () => {
  native.cancelTimeout(lastInterval);
  throw new Error("interval without listener");
});
await pumpFor(150);
report.printedWithoutListener = printed.splice(0);
report.arrivalsWithoutListener = arrivals.length;

console.error = originalError;
finish();
