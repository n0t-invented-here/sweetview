// Native timers inside a tray menu's modal loop, through the binding (decision D38; the second
// review's G1). A tray whose right click is posted to its window opens its menu from a deferred
// job; a native interval set a moment before the click ticks inside the menu's loop and closes the
// menu after three ticks. The menu function waits longer than the interval's period and the pump
// guard's before it returns, so every native timer of the thread is due when the menu's loop first
// looks at the queue: the moment at which timers on WM_TIMER stopped. A worker closes a menu still
// open 1.5 s after it was armed, with Escape, and counts it. Run as its own process, once per loop
// mode:
//
//   SWEETVIEW_LOOP_MODE=blocking|pumped bun timers-in-tray-menu.ts [rounds]
//
// Prints one line `RESULT {"mode", "rounds", "ticked": [...], "rescued", "timedOut"?}`.

import { binding } from "../../src/binding";
import { createTray } from "../../src/win32/tray";
import { TRAY, endMenu, openPopupMenu, postTrayMouse } from "../win32-os";

const mode = process.env.SWEETVIEW_LOOP_MODE === "pumped" ? "pumped" : "blocking";
const rounds = Number(process.argv[2] ?? 8);
const native = binding();

// [0]: when the open menu was armed (ms, 30 bits; 0 when none), [1]: menus the worker closed.
const shared = new SharedArrayBuffer(8);
const flag = new Int32Array(shared);
const rescue = new Worker(new URL("./menu-rescue-worker.ts", import.meta.url).href);
rescue.postMessage(shared);
const now30 = () => Date.now() & 0x3fffffff;

const report: { mode: string; rounds: number; ticked: number[]; rescued: number; timedOut?: boolean } = { mode, rounds, ticked: [], rescued: 0 };
let done = false;
let ticks = 0;
let opening = false;

const tray = createTray({
  tooltip: `sweetview timers-in-tray-menu fixture ${process.pid}`,
  menu: () => {
    // Longer than the interval's 10 ms and the pump guard's 15 ms.
    Bun.sleepSync(40);
    opening = true;
    Atomics.store(flag, 0, now30());
    return [{ label: "One", click: () => {} }];
  },
});

function finish() {
  done = true;
  tray.dispose();
  rescue.terminate();
  if (mode === "blocking") native.quitLoop();
}

function round() {
  if (report.ticked.length === rounds) return finish();
  ticks = 0;
  opening = false;
  const started = Date.now();
  const rescuedBefore = Atomics.load(flag, 1);
  const interval = native.scheduleInterval(10, () => {
    if (!opening || openPopupMenu() === 0n) return;
    if (++ticks === 3) endMenu();
  });
  postTrayMouse(tray.windowHandle(), TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
  // Ends the round once the menu has opened and closed again (or after 8 s).
  const watch = native.scheduleInterval(20, () => {
    const over = (opening && openPopupMenu() === 0n) || Date.now() - started > 8000;
    if (!over) return;
    native.cancelTimeout(watch);
    native.cancelTimeout(interval);
    Atomics.store(flag, 0, 0);
    report.ticked.push(ticks);
    if (Atomics.load(flag, 1) > rescuedBefore) report.rescued++;
    native.scheduleTimeout(100, round);
  });
}

native.scheduleTimeout(300, round);
const limit = native.scheduleTimeout(90_000, () => {
  report.timedOut = true;
  finish();
});
if (mode === "blocking") {
  native.runLoop();
} else {
  while (!done) {
    native.pumpEvents();
    Bun.sleepSync(5);
  }
}
native.cancelTimeout(limit);
console.log(`RESULT ${JSON.stringify(report)}`);
process.exit(0);
