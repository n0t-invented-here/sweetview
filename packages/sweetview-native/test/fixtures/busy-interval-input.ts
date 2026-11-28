// A busy native interval does not hold back input or paint (decision D38; the third review's H1).
// A 10 ms interval whose job takes 15 ms runs the whole time. A window of this process's own,
// shown at a fixed place, is clicked with real input (SendInput, over the window) and asked to
// repaint (InvalidateRect), in turns; each wait is measured from the request to the window
// procedure's WM_LBUTTONDOWN or WM_PAINT. Run as its own process, once per loop mode:
//
//   SWEETVIEW_LOOP_MODE=blocking|pumped bun busy-interval-input.ts [rounds]
//
// Prints `RESULT {"mode", "ticks", "input": [ms...], "paint": [ms...], "notRun"?}`. The window is
// shown, clicked and repainted through bun:ffi: it is the application's own, which is the case the
// test is about.

import { dlopen, FFIType } from "bun:ffi";
import { binding } from "../../src/binding";
import { buttonsDown, cursor, injectLeftButton, ownWindow, windowAt } from "../win32-os";

const mode = process.env.SWEETVIEW_LOOP_MODE === "pumped" ? "pumped" : "blocking";
const rounds = Number(process.argv[2] ?? 8);
const native = binding();
const user32 = dlopen("user32.dll", {
  SetWindowPos: { args: [FFIType.u64, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  InvalidateRect: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols;
const WM_PAINT = 0x000f;
const WM_LBUTTONDOWN = 0x0201;
const HWND_TOPMOST = 0xffffffffffffffffn; // (HWND)-1
const SWP_SHOWWINDOW = 0x0040;
const AT = { x: 240, y: 240, width: 320, height: 220 };
const CENTRE = { x: AT.x + AT.width / 2, y: AT.y + AT.height / 2 };

const report: { mode: string; ticks: number; input: number[]; paint: number[]; notRun?: string } = { mode, ticks: 0, input: [], paint: [] };
let askedInput = 0;
let askedPaint = 0;
const own = ownWindow((message) => {
  if (message === WM_LBUTTONDOWN && askedInput > 0) {
    report.input.push(Math.round(performance.now() - askedInput));
    askedInput = 0;
  } else if (message === WM_PAINT && askedPaint > 0) {
    report.paint.push(Math.round(performance.now() - askedPaint));
    askedPaint = 0;
  }
});
user32.SetWindowPos(own.hwnd, HWND_TOPMOST, AT.x, AT.y, AT.width, AT.height, SWP_SHOWWINDOW);
user32.ShowWindow(own.hwnd, 5); // SW_SHOW
user32.SetForegroundWindow(own.hwnd);
const original = cursor();

const interval = native.scheduleInterval(10, () => {
  report.ticks++;
  Bun.sleepSync(15);
});

let done = false;
function finish(notRun?: string) {
  if (notRun) report.notRun = notRun;
  native.cancelTimeout(interval);
  injectLeftButton(false);
  user32.SetCursorPos(original.x, original.y);
  done = true;
  if (mode === "blocking") native.quitLoop();
}

let round = 0;
let tries = 0;
function step() {
  if (askedInput > 0 || askedPaint > 0) {
    // The last request is still waiting; look again shortly (at most 2 s in all).
    if (performance.now() - Math.max(askedInput, askedPaint) > 2000) return finish();
    return void native.scheduleTimeout(20, step);
  }
  if (round >= rounds) return finish();
  if (round % 2 === 0) {
    user32.SetCursorPos(CENTRE.x, CENTRE.y);
    if (windowAt(CENTRE.x, CENTRE.y) !== own.hwnd || buttonsDown()) {
      if (++tries > 20) return finish("the window was not under the cursor, or a button was held, on the shared desktop");
      return void native.scheduleTimeout(100, step);
    }
    askedInput = performance.now();
    injectLeftButton(true);
    injectLeftButton(false);
  } else {
    askedPaint = performance.now();
    user32.InvalidateRect(own.hwnd, null, 1);
  }
  round++;
  native.scheduleTimeout(120, step);
}

native.scheduleTimeout(400, step);
const limit = native.scheduleTimeout(60_000, () => finish("the fixture's limit"));
if (mode === "blocking") {
  native.runLoop();
} else {
  while (!done) {
    native.pumpEvents();
    Bun.sleepSync(2);
  }
}
native.cancelTimeout(limit);
own.destroy();
console.log(`RESULT ${JSON.stringify(report)}`);
process.exit(0);
