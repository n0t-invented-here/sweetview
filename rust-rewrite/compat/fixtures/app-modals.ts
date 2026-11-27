// W4.8: an application made with `createApp` whose `uiMethods` open the application's own modal
// loops through bun:ffi (MessageBoxW, then TrackPopupMenu), called from its page. While each loop
// is open the page keeps calling a UI method and a worker method, and reports every answer it gets
// back through another UI method: an answer counts when it names the loop still open. Run once per
// loop mode by own-modal-loops.test.ts:
//
//   bun app-modals.ts blocking   app.run()
//   bun app-modals.ts pumped     runEventLoop(), the Bun-timer loop
//
// A native timeout inside each loop closes it (WM_CLOSE to the box, EndMenu for the menu) once
// the page has had its answers, or after a bound. Prints one line `RESULT <json>`.

import { FFIType, dlopen } from "bun:ffi";
import { createApp } from "@n1h/sweetview";
import { quitEventLoop, runEventLoop } from "@n1h/sweetview-native";
import { scheduleNativeTimeout } from "@n1h/sweetview-native/internal";

const mode = process.argv[2] === "pumped" ? "pumped" : "blocking";
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
const wide = (s: string) => new Uint8Array(Buffer.from(`${s}\0`, "utf16le"));
const WM_CLOSE = 0x0010;
const TPM_RETURNCMD = 0x0100;
const TPM_NONOTIFY = 0x0080;
const BOX_TITLE = `sweetview compat app modal ${process.pid}`;

type Kind = "box" | "menu";
const counts = () => ({ uiCalls: 0, uiAnswersSeenByPage: 0, workerAnswersSeenByPage: 0 });
const report = {
  mode,
  inside: { box: counts(), menu: counts() },
  boxReturned: false,
  menuReturned: null as number | null,
  finished: false,
  timedOut: false,
};
let inModal: Kind | null = null;

/** Closes the loop of `kind` once the page has had its answers inside it, or after a bound. */
function closeWhenSeen(kind: Kind, close: () => void): void {
  const opened = performance.now();
  const check = () => {
    if (inModal !== kind) return;
    const seen = report.inside[kind];
    if ((seen.uiAnswersSeenByPage >= 3 && seen.workerAnswersSeenByPage >= 3) || performance.now() - opened > 8000) close();
    else scheduleNativeTimeout(50, check);
  };
  scheduleNativeTimeout(50, check);
}

let quit = () => {};
/** The app window's handle: the owner of the popup menu, set once the app is made. */
let owner = 0n;
const page = `<!doctype html><body><script>
  const rpc = window.__sweetview_rpc;
  let stop = false;
  (async () => {
    // Calls made while the UI thread is inside the application's modal loop.
    const pinger = (async () => {
      while (!stop) {
        // The worker is asked only after the UI thread said which loop is open, and is asked about
        // that loop: its answer names it, so an answer recorded while the loop is still open
        // crossed the ring and the wake inside it.
        const ui = await rpc("where", null);
        const worker = await rpc("echo", ui ?? "none");
        await rpc("record", { ui, worker });
        await new Promise((r) => setTimeout(r, 30));
      }
    })();
    await rpc("openBox", null);
    await rpc("openMenu", null);
    stop = true;
    await pinger;
    await rpc("finish", null);
  })();
</script></body>`;

const app = await createApp({
  title: `compat app modals ${mode} ${process.pid}`,
  bounds: { x: -3000, y: -3000, width: 320, height: 240 },
  frame: false,
  noActivate: true,
  hideFromTaskbar: true,
  worker: new URL("./app-modals.worker.ts", import.meta.url),
  assets: { "index.html": new TextEncoder().encode(page) },
  uiMethods: {
    where: () => {
      if (inModal) report.inside[inModal].uiCalls++;
      return inModal;
    },
    record: (params: unknown) => {
      const { ui, worker } = params as { ui: Kind | null; worker: string };
      if (inModal === null) return;
      if (ui === inModal) report.inside[inModal].uiAnswersSeenByPage++;
      // The worker's answer arrived (through the ring and the wake) while the loop was open.
      if (worker === `worker saw ${inModal}`) report.inside[inModal].workerAnswersSeenByPage++;
    },
    openBox: () => {
      inModal = "box";
      closeWhenSeen("box", () => {
        const box = user32.FindWindowW(null, wide(BOX_TITLE));
        if (box !== 0n) user32.PostMessageW(box, WM_CLOSE, 0n, 0n);
      });
      user32.MessageBoxW(0n, wide("Closed by the test."), wide(BOX_TITLE), 0);
      inModal = null;
      report.boxReturned = true;
      return "box closed";
    },
    openMenu: () => {
      inModal = "menu";
      closeWhenSeen("menu", () => void user32.EndMenu());
      const menu = user32.CreatePopupMenu();
      user32.AppendMenuW(menu, 0, 1n, wide("One"));
      const chosen: number = user32.TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY, -2900, -2900, 0, owner, null);
      user32.DestroyMenu(menu);
      inModal = null;
      report.menuReturned = chosen;
      return chosen;
    },
    finish: () => {
      report.finished = true;
      quit();
    },
  },
});

owner = BigInt(app.window.handle!);
const watchdog = scheduleNativeTimeout(30_000, () => {
  report.timedOut = true;
  quit();
});
if (mode === "blocking") {
  quit = () => app.quit();
  app.run();
} else {
  quit = () => quitEventLoop();
  await runEventLoop({ intervalMs: 4 });
}
watchdog();
app.dispose();
console.log("RESULT " + JSON.stringify(report));
process.exit(0);
