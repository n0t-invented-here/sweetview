// A handler run on the UI thread opens a modal loop of its own, and while it is open the page's
// calls are still answered (and the answers reach the page), a Worker's wake still drains and a
// native timeout still fires (checklist item W1.8). Two modal loops, one after the other: the
// application's own message box, then its own popup menu. Run as its own process, once per loop
// mode:
//
//   SWEETVIEW_LOOP_MODE=blocking|pumped bun modal-loop.ts
//
// The modal loops are the application's own: MessageBoxW and TrackPopupMenu called through
// bun:ffi, which is why this fixture uses bun:ffi. A native interval inside each loop closes it:
// WM_CLOSE posted to the box, EndMenu for the menu.

import { dlopen, FFIType } from "bun:ffi";
import { Ring } from "../../../sweetview/src/ring";
import { binding } from "../../src/binding";
import { SizeHint, Webview } from "../../src/index";

const mode = process.env.SWEETVIEW_LOOP_MODE === "pumped" ? "pumped" : "blocking";
const native = binding();
const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
const user32 = dlopen("user32.dll", {
  MessageBoxW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
  CreatePopupMenu: { args: [], returns: FFIType.u64 },
  AppendMenuW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  TrackPopupMenu: { args: [FFIType.u64, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  DestroyMenu: { args: [FFIType.u64], returns: FFIType.i32 },
  EndMenu: { args: [], returns: FFIType.i32 },
}).symbols;
const WM_CLOSE = 0x0010;
const TPM_RETURNCMD = 0x0100;
const TPM_NONOTIFY = 0x0080;
const BOX_TITLE = `sweetview modal fixture ${process.pid}`;

type Kind = "box" | "menu";
const counts = () => ({ pageCalls: 0, repliesSeenByPage: 0, drains: 0, timeouts: 0 });
const report = {
  mode,
  modalOpened: false,
  modalReturned: false,
  // The message box, counted only while it is open (the names W1.8's evidence has used):
  pageCallsInsideModal: 0,
  drainsInsideModal: 0,
  timeoutsInsideModal: 0,
  // Per modal loop, counted only while it is open; repliesSeenByPage: the page reported an answer
  // it received to a call made while that loop was open, and the report arrived while it still was.
  inside: { box: counts(), menu: counts() },
  menuOpened: false,
  menuReturned: null as number | null,
  framesFromWorker: [] as string[],
};
let inModal: Kind | null = null;

// The worker's hop: a frame into the ring, then the wake.
const sab = Ring.create(1024);
const ring = new Ring(sab);
const DRAIN_TOKEN = 7801;
native.setDrain(DRAIN_TOKEN, () => {
  ring.acknowledgeWakeup();
  for (const bytes of ring.drain()) report.framesFromWorker.push(new TextDecoder().decode(bytes));
  if (inModal) report.inside[inModal].drains++;
  if (inModal === "box") report.drainsInsideModal++;
});
const worker = new Worker(new URL("../../src/binding.test.worker.ts", import.meta.url).href);
worker.postMessage({ kind: "probe" });
await new Promise<void>((resolve) => (worker.onmessage = () => resolve()));
worker.onmessage = null;

/** While `kind` is open: a native timeout fires and has the worker write and wake. Returns when the loop should close. */
function insideLoop(kind: Kind, opened: number, close: () => void): void {
  native.scheduleTimeout(150, () => {
    if (inModal === kind) report.inside[kind].timeouts++;
    if (inModal === "box") report.timeoutsInsideModal++;
    worker.postMessage({ kind: "write", ring: sab, token: DRAIN_TOKEN, text: `written while the ${kind} was open` });
  });
  const closer = native.scheduleInterval(50, () => {
    // Close once everything that should happen inside it has, or after a bound.
    const seen = report.inside[kind];
    const done = seen.pageCalls >= 3 && seen.repliesSeenByPage >= 3 && seen.drains >= 1 && seen.timeouts >= 1;
    if (!done && performance.now() - opened < 6000) return;
    close();
    native.cancelTimeout(closer);
  });
}

const webview = new Webview(false, { width: 420, height: 240, hint: SizeHint.NONE });
webview.title = "sweetview modal fixture";
webview.bind("ping", () => {
  if (inModal) report.inside[inModal].pageCalls++;
  if (inModal === "box") report.pageCallsInsideModal++;
  return inModal;
});
// The page reports the answer it got; it counts when that answer named the loop still open.
webview.bind("record", (answer: Kind | null) => {
  if (answer !== null && answer === inModal) report.inside[answer].repliesSeenByPage++;
});
webview.bind("openModal", () => {
  report.modalOpened = true;
  inModal = "box";
  insideLoop("box", performance.now(), () => {
    const box = user32.FindWindowW(null, wide(BOX_TITLE));
    if (box !== 0n) user32.PostMessageW(box, WM_CLOSE, 0n, 0n);
  });
  user32.MessageBoxW(0n, wide("Open while the page keeps calling."), wide(BOX_TITLE), 0);
  inModal = null;
  report.modalReturned = true;
  return "closed";
});
webview.bind("openMenu", () => {
  report.menuOpened = true;
  inModal = "menu";
  insideLoop("menu", performance.now(), () => void user32.EndMenu());
  const menu = user32.CreatePopupMenu();
  user32.AppendMenuW(menu, 0, 1n, wide("One"));
  const chosen = user32.TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY, -2900, -2900, 0, BigInt(webview.unsafeWindowHandle!), null);
  user32.DestroyMenu(menu);
  inModal = null;
  report.menuReturned = chosen;
  return "closed";
});
webview.bind("finish", () => {
  console.log("RESULT " + JSON.stringify(report));
  worker.terminate();
  webview.destroy();
  if (mode === "pumped") finishPumped();
});
webview.setHTML(`<!doctype html><body><script>
  (async () => {
    const pinger = setInterval(() => { ping().then((answer) => record(answer)).catch(() => {}); }, 30);
    await openModal();
    await openMenu();
    clearInterval(pinger);
    await finish();
  })();
</script>`);

let finishPumped = () => {};
if (mode === "blocking") {
  const watchdog = native.scheduleTimeout(30_000, () => {
    console.log("RESULT " + JSON.stringify({ ...report, timedOut: true }));
    native.quitLoop();
  });
  webview.run();
  native.cancelTimeout(watchdog);
} else {
  // The loop pumped from a Bun timer: Bun's own loop keeps turning between pumps.
  await new Promise<void>((resolve) => {
    const pump = setInterval(() => native.pumpEvents(), 8);
    const watchdog = setTimeout(() => {
      console.log("RESULT " + JSON.stringify({ ...report, timedOut: true }));
      finishPumped();
    }, 30_000);
    finishPumped = () => {
      clearInterval(pump);
      clearTimeout(watchdog);
      resolve();
    };
  });
}
process.exit(0);
