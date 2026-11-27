// W1.3: an exception thrown from each non-webview kind of callback straight
// through the binding, with no TypeScript wrapper in between, so it reaches
// `JsCallback::call` in sweetview-napi. The binding logs
// "sweetview: <kind> threw: <reason>" on stderr and uses the kind's fallback.
// Run by src/callbacks.test.ts in a process of its own (it reads this
// process's stderr); prints one line `RESULT <json>`. The webview's kinds are
// thrown from by fixtures/webview-callbacks.ts.
//
// Inputs are posted or sent to this process's own windows, the cursor is
// moved over a window of its own (restored after), and F24 and a few pixels
// of pointer movement are injected with SendInput for the hooks; every key
// pressed is released.

import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { packRegions } from "../../src/hit-regions";
import { TRAY, VK, doubleClickTime, endMenu, openPopupMenu, postTrayMouse, pressKeys } from "../win32-os";
import { finish, native, report, watchdog } from "./kit";

watchdog(50_000);

const user32 = dlopen("user32.dll", {
  FindWindowExW: { args: [FFIType.i64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
  SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols;
const kernel32 = dlopen("kernel32.dll", {
  GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: FFIType.u64 },
  GlobalLock: { args: [FFIType.u64], returns: FFIType.ptr },
  GlobalUnlock: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols;

const WM_CLOSE = 0x0010;
const WM_COPYDATA = 0x004a;
const WM_DROPFILES = 0x0233;
const VK_F24 = 0x87;

async function pumpUntil(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    native.pumpEvents();
    await Bun.sleep(5);
  }
  native.pumpEvents();
}

const boom = (what: string) => () => {
  throw new Error(what);
};

function cursorNow(): { x: number; y: number } {
  const point = new Int32Array(2);
  user32.GetCursorPos(point);
  return { x: point[0]!, y: point[1]! };
}

function input(fill: (view: DataView) => void): void {
  const view = new DataView(new ArrayBuffer(40)); // INPUT on x64
  fill(view);
  user32.SendInput(1, ptr(view.buffer), 40);
}
const sendKey = (up: boolean) =>
  input((v) => {
    v.setUint32(0, 1, true); // INPUT_KEYBOARD
    v.setUint16(8, VK_F24, true);
    v.setUint32(12, up ? 0x0002 : 0, true);
  });
const sendMouseMove = (dx: number) =>
  input((v) => {
    v.setUint32(0, 0, true); // INPUT_MOUSE
    v.setInt32(8, dx, true);
    v.setUint32(20, 0x0001, true); // MOUSEEVENTF_MOVE
  });

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");

// ---- loop kinds ---------------------------------------------------------------------------

native.defer(boom("deferred boom"));
native.defer(() => void (report.deferredAfter = true));
await pumpUntil(() => report.deferredAfter === true);

native.scheduleTimeout(1, boom("timeout boom"));
native.scheduleTimeout(20, () => void (report.timeoutAfter = true));
await pumpUntil(() => report.timeoutAfter === true);

// A throwing interval keeps its schedule; it cancels itself on its third run.
let intervalCalls = 0;
const interval: number = native.scheduleInterval(5, () => {
  intervalCalls++;
  if (intervalCalls === 3) native.cancelTimeout(interval);
  throw new Error("interval boom");
});
await pumpUntil(() => intervalCalls >= 3);
await pumpUntil(() => false, 60);
report.intervalCalls = intervalCalls;

// A drain that threw is still registered.
let drains = 0;
native.setDrain(9301, () => {
  drains++;
  if (drains === 1) throw new Error("drain boom");
});
native.wake(9301);
await pumpUntil(() => drains === 1);
native.wake(9301);
await pumpUntil(() => drains === 2);
native.setDrain(9301, null);
report.drains = drains;

// A transform that throws hands `null` to `done`; a `done` that throws is logged as well.
let probed = 0;
native.probeRoundTrip(1, "ping", boom("probe boom"), (out) => {
  report.probeTransformThrew = out ?? null;
  probed++;
});
native.probeRoundTrip(1, "ping", () => "pong", (out) => {
  report.probeDone = out;
  probed++;
  throw new Error("probe completion boom");
});
await pumpUntil(() => probed === 2);

// ---- a window's kinds ---------------------------------------------------------------------

const init = {
  title: `callback-backstop ${process.pid}`,
  bounds: { x: -3000, y: -3000, width: 300, height: 200 },
  frame: false,
  resizable: false,
  appearance: "system",
  transparent: false,
  topmost: false,
  hideFromTaskbar: true,
  noActivate: true,
};
const win = native.Window.create(init);
const hwnd = win.handle;
win.onResize(boom("resize boom"));
win.onMove(boom("move boom"));
win.setBounds({ x: -2990, y: -3000, width: 310, height: 200 });
report.windowAfterEvents = win.bounds().width === 310;
win.onCloseRequest(boom("close boom"));
user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
report.closeRequestTaken = user32.IsWindow(hwnd) !== 0; // a listener that threw still took it

let drops = 0;
win.onFileDrop(() => {
  drops++;
  throw new Error("drop boom");
});
{
  const body = Buffer.from("C:\\example\\one.txt\0\0", "utf16le");
  const dropFiles = Buffer.alloc(20 + body.length);
  dropFiles.writeUInt32LE(20, 0);
  dropFiles.writeInt32LE(1, 16);
  body.copy(dropFiles, 20);
  const drop = kernel32.GlobalAlloc(0x0002, BigInt(dropFiles.length));
  const memory = kernel32.GlobalLock(drop)!;
  new Uint8Array(toArrayBuffer(memory, 0, dropFiles.length)).set(dropFiles);
  kernel32.GlobalUnlock(drop);
  user32.SendMessageW(hwnd, WM_DROPFILES, drop, 0n);
}
report.dropAfter = drops === 1 && user32.IsWindow(hwnd) !== 0;

// With no close listener the default close runs; it throws here.
win.onCloseRequest(null);
win.onDefaultClose(boom("default close boom"));
user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
report.windowAfterDefaultCloseThrew = user32.IsWindow(hwnd) !== 0;
win.dispose();

// The refiner: the cursor is moved into a polygon of a shown window of this process's own. Other
// sessions share the desktop (a held button freezes the poll; the cursor can be moved away), so
// the step is tried up to five times; the test fails with `refineSkipped` if it never ran.
for (let attempt = 1; attempt <= 5 && report.refinerAsked !== true; attempt++) {
  if (attempt > 1) await pumpUntil(() => false, 250);
  if ([0x01, 0x02, 0x04].some((vk) => user32.GetAsyncKeyState(vk) < 0)) {
    report.refineSkipped = `a mouse button is held, which freezes the poll (${attempt} attempts)`;
    continue;
  }
  const original = cursorNow();
  const at = { x: 300, y: 280 };
  const shown = native.Window.create({ ...init, bounds: { ...at, width: 300, height: 200 }, topmost: true });
  let asked = 0;
  try {
    shown.show();
    user32.SetCursorPos(at.x + 250, at.y + 50);
    await pumpUntil(() => false, 60);
    shown.setHitRegions(packRegions([[{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 200 }, { x: 0, y: 200 }]]), () => {
      asked++;
      throw new Error("refine boom");
    });
    user32.SetCursorPos(at.x + 40, at.y + 40);
    await pumpUntil(() => asked > 0, 2000);
    report.refinerAsked = asked > 0;
    if (asked === 0) report.refineSkipped = `the poll did not ask; another session moved the cursor (${attempt} attempts)`;
    else delete report.refineSkipped;
  } finally {
    user32.SetCursorPos(original.x, original.y);
    shown.dispose();
  }
}

// A tab frame's activation listener: a window made with a tab strip, activated and deactivated
// by WM_ACTIVATE sent to it, as the OS sends it.
{
  const WM_ACTIVATE = 0x0006;
  const framed = native.Window.create({ ...init, frame: true, tabStripHeight: 36 });
  const tab = native.TabFrame.of(framed.handle)!;
  const seen: boolean[] = [];
  tab.onActivate((active) => {
    seen.push(active);
    throw new Error("activate boom");
  });
  user32.SendMessageW(framed.handle, WM_ACTIVATE, 1n, 0n); // WA_ACTIVE
  user32.SendMessageW(framed.handle, WM_ACTIVATE, 0n, 0n); // WA_INACTIVE
  report.tabActivations = seen;
  report.tabFrameLiveAfterThrow = tab.live && user32.IsWindow(framed.handle) !== 0;
  framed.dispose();
}

// ---- the tray -----------------------------------------------------------------------------

let trayClicks = 0;
let trayDoubleClicks = 0;
let menuOpens = 0;
let chosen = 0;
const tray = new native.Tray(
  `callback-backstop ${process.pid}`,
  null,
  true,
  () => {
    trayClicks++;
    throw new Error("tray click boom");
  },
  () => {
    trayDoubleClicks++;
    throw new Error("tray double-click boom");
  },
  () => {
    menuOpens++;
    if (menuOpens === 1) throw new Error("tray menu function boom");
    return [{ kind: "item", id: 1, label: "One", enabled: true, checked: false }];
  },
  () => {
    chosen++;
    throw new Error("tray menu handler boom");
  },
);
const trayWindow = tray.windowHandle;
// As the shell reports a double click: the up after it is the double click's own.
postTrayMouse(trayWindow, TRAY.LBUTTONDBLCLK, TRAY.LBUTTONUP);
await pumpUntil(() => trayDoubleClicks === 1);
for (let round = 1; round <= 2; round++) {
  postTrayMouse(trayWindow, TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
  await pumpUntil(() => trayClicks === round, doubleClickTime() + 2000);
}
postTrayMouse(trayWindow, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
await pumpUntil(() => menuOpens === 1);
await pumpUntil(() => false, 200);
report.trayNoMenuAfterThrow = openPopupMenu() === 0n;
// A popup menu closes unchosen when another window takes the foreground (other
// sessions share this desktop): a menu that closed unchosen is opened again.
for (let attempt = 0; attempt < 3 && chosen === 0; attempt++) {
  let shown = false;
  const started = Date.now();
  const id: number = native.scheduleInterval(10, () => {
    const menuWindow = openPopupMenu();
    if (menuWindow !== 0n) {
      native.cancelTimeout(id);
      native.scheduleTimeout(3000, () => void (openPopupMenu() !== 0n && endMenu()));
      shown = true;
      pressKeys(menuWindow, VK.DOWN, VK.RETURN);
    } else if (Date.now() - started > 5000) {
      native.cancelTimeout(id);
    }
  });
  postTrayMouse(trayWindow, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
  await pumpUntil(() => chosen === 1 || (shown && openPopupMenu() === 0n));
  await pumpUntil(() => openPopupMenu() === 0n, 1000);
}
tray.dispose();
Object.assign(report, { trayClicks, trayDoubleClicks, trayChosen: chosen });

// ---- the notifier -------------------------------------------------------------------------

let notifierClicks = 0;
const notifier = new native.Notifier(null, null, null, () => {
  notifierClicks++;
  throw new Error("notification boom");
});
notifier.debugForcePath("balloonOnly");
for (let round = 1; round <= 2; round++) {
  const shown = notifier.debugShow(`n${round}`, "Backstop", "", true, null)!;
  notifier.debugSimulateBalloonEvent(Number(shown.slice("balloon:".length)), "clicked");
  await pumpUntil(() => notifierClicks === round);
}
notifier.dispose();
report.notifierClicks = notifierClicks;

// ---- the single-instance handoff ----------------------------------------------------------

{
  const appId = `dev.sweetview.test.backstop-${process.pid}-${Date.now()}`;
  const lock = native.SingleInstance.acquire(appId, JSON.stringify({ args: [], cwd: "C:\\" }), boom("second instance boom"));
  const target = user32.FindWindowExW(-3n, 0n, ptr(wide("SweetviewSingleInstanceWindow")), ptr(wide(`sweetview.instance.${appId}`)));
  const answers: number[] = [];
  for (let round = 0; round < 2; round++) {
    const bytes = new Uint8Array(Buffer.from(JSON.stringify({ args: [`--round=${round}`], cwd: "C:\\" }), "utf8"));
    const data = new DataView(new ArrayBuffer(24));
    data.setBigUint64(0, 0x53575631n, true);
    data.setUint32(8, bytes.length, true);
    data.setBigUint64(16, BigInt(ptr(bytes)), true);
    answers.push(Number(user32.SendMessageW(target, WM_COPYDATA, 0n, BigInt(ptr(data.buffer)))));
  }
  lock.dispose();
  report.handOffAnswers = answers;
}

// ---- the hooks: a handler that threw does not swallow -------------------------------------

{
  let calls = 0;
  native.installKeyboardHook((_event, code) => {
    if (code !== "F24") return false;
    calls++;
    throw new Error("keyboard boom");
  });
  sendKey(false);
  await pumpUntil(() => calls > 0 && user32.GetAsyncKeyState(VK_F24) < 0, 3000);
  report.keyReachedSystem = user32.GetAsyncKeyState(VK_F24) < 0;
  report.keyboardCalls = calls;
  native.removeKeyboardHook();
  sendKey(true);
}
{
  const original = cursorNow();
  let calls = 0;
  native.installMouseHook(() => {
    calls++;
    throw new Error("mouse boom");
  });
  // Away from the nearer screen edge, where the cursor could not move further.
  sendMouseMove(original.x > 100 ? -8 : 8);
  await pumpUntil(() => calls > 0 && cursorNow().x !== original.x, 3000);
  report.mouseMoved = cursorNow().x !== original.x;
  native.removeMouseHook();
  user32.SetCursorPos(original.x, original.y);
}

finish();
