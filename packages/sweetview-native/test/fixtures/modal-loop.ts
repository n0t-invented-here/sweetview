// A handler run on the UI thread opens a modal loop of its own, and while it is open the page's
// calls are still answered, a Worker's wake still drains and a native timeout still fires
// (checklist item W1.8). Run as its own process, once per loop mode:
//
//   SWEETVIEW_LOOP_MODE=blocking|pumped bun modal-loop.ts
//
// The modal loop is the application's own: a MessageBoxW called through bun:ffi, which is why
// this fixture uses bun:ffi. A native timeout closes it by posting WM_CLOSE to the box.

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
}).symbols;
const WM_CLOSE = 0x0010;
const BOX_TITLE = `sweetview modal fixture ${process.pid}`;

const report = {
  mode,
  modalOpened: false,
  modalReturned: false,
  // Counted only while the box is open:
  pageCallsInsideModal: 0,
  drainsInsideModal: 0,
  timeoutsInsideModal: 0,
  framesFromWorker: [] as string[],
};
let inModal = false;

// The worker's hop: a frame into the ring, then the wake.
const sab = Ring.create(1024);
const ring = new Ring(sab);
const DRAIN_TOKEN = 7801;
native.setDrain(DRAIN_TOKEN, () => {
  ring.acknowledgeWakeup();
  for (const bytes of ring.drain()) report.framesFromWorker.push(new TextDecoder().decode(bytes));
  if (inModal) report.drainsInsideModal++;
});
const worker = new Worker(new URL("../../src/binding.test.worker.ts", import.meta.url).href);
worker.postMessage({ kind: "probe" });
await new Promise<void>((resolve) => (worker.onmessage = () => resolve()));
worker.onmessage = null;

const webview = new Webview(false, { width: 420, height: 240, hint: SizeHint.NONE });
webview.title = "sweetview modal fixture";
webview.bind("ping", () => {
  if (inModal) report.pageCallsInsideModal++;
  return inModal;
});
webview.bind("openModal", () => {
  report.modalOpened = true;
  inModal = true;
  // While the box is open: a native timeout fires, the worker writes and wakes, and the page pings.
  native.scheduleTimeout(150, () => {
    if (inModal) report.timeoutsInsideModal++;
    worker.postMessage({ kind: "write", ring: sab, token: DRAIN_TOKEN, text: "written while the box was open" });
  });
  const closer = native.scheduleInterval(50, () => {
    // Close the box once everything that should happen inside it has, or after a bound.
    const done = report.pageCallsInsideModal >= 3 && report.drainsInsideModal >= 1 && report.timeoutsInsideModal >= 1;
    if (!done && performance.now() - opened < 6000) return;
    const box = user32.FindWindowW(null, wide(BOX_TITLE));
    if (box !== 0n) user32.PostMessageW(box, WM_CLOSE, 0n, 0n);
    native.cancelTimeout(closer);
  });
  const opened = performance.now();
  user32.MessageBoxW(0n, wide("Open while the page keeps calling."), wide(BOX_TITLE), 0);
  inModal = false;
  report.modalReturned = true;
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
    const pinger = setInterval(() => { ping().catch(() => {}); }, 30);
    await openModal();
    clearInterval(pinger);
    await finish();
  })();
</script>`);

let finishPumped = () => {};
if (mode === "blocking") {
  const watchdog = native.scheduleTimeout(20_000, () => {
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
    }, 20_000);
    finishPumped = () => {
      clearInterval(pump);
      clearTimeout(watchdog);
      resolve();
    };
  });
}
process.exit(0);
