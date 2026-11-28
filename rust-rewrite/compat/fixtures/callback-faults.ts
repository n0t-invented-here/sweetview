// "Exceptions thrown by your callbacks" in docs/native.md and docs/app.md, and the bullet and step
// of docs/upgrading.md, run for real: an exception an application's handler throws on the UI
// thread never reaches `process.on("uncaughtException")` by itself; with no `onCallbackError`
// listener Sweetview logs it as before (and a page call, a request and a worker method's rejection
// stay silent); with one, every one of them reaches the listener with its kind, nothing is printed,
// and the fallbacks still apply. A listener that hands the error to the process's own
// `uncaughtException` listeners, or exits, is the whole of what an application writes.
//
// The callbacks are driven by what the OS or the page would deliver: the shell's tray messages and
// keys posted to the open menu's window, WM_CLOSE, and a page that calls its methods and fetches a
// dynamic path without awaiting anything. No input is injected.
//
//   bun callback-faults.ts            prints one JSON line; the parent reads stderr too
//   bun callback-faults.ts exit       the listener calls process.exit(3) from inside a tray click

import { createApp } from "@n1h/sweetview";
import { Menu, Tray, Window, onCallbackError, type CallbackErrorSource } from "@n1h/sweetview/native";
import { binding } from "../../../packages/sweetview-native/src/binding";
import { currentTray } from "../../../packages/sweetview-native/src/win32/tray";
import { TRAY, VK, WM_CLOSE, doubleClickTime, openPopupMenu, postTrayMouse, pressKeys, user32 } from "../../../packages/sweetview-native/test/win32-os";

const native = binding();
const mode = process.argv[2] ?? "report";
const reachedUncaught: string[] = [];
process.on("uncaughtException", (err) => {
  reachedUncaught.push(err.message);
});

async function pumpUntil(done: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    native.pumpEvents();
    await Bun.sleep(5);
  }
  native.pumpEvents();
  return done();
}

/** Opens the tray's menu as a right click on its icon does, and chooses its first item with keys posted to the menu. */
async function chooseFirstItem(trayWindow: bigint, chosen: () => boolean): Promise<boolean> {
  for (let attempt = 1; attempt <= 3 && !chosen(); attempt++) {
    const watcher = native.scheduleInterval(10, () => {
      const menu = openPopupMenu();
      if (menu === 0n) return;
      native.cancelTimeout(watcher);
      pressKeys(menu, VK.DOWN, VK.RETURN);
    });
    postTrayMouse(trayWindow, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
    await pumpUntil(chosen, 3000);
    native.cancelTimeout(watcher);
    await pumpUntil(() => openPopupMenu() === 0n, 1000);
  }
  return chosen();
}

/** Throws once from each kind, every message starting with `label`; returns what ran and what the page saw. */
async function throwFromEach(label: string): Promise<Record<string, unknown>> {
  const ran = { trayClick: false, menuItem: false, onClose: false, uiMethod: false, deferredUiMethod: false, onRequest: false, onReady: false };

  const tray = new Tray({
    tooltip: `sweetview compat faults ${label} ${process.pid}`,
    onClick: () => {
      ran.trayClick = true;
      throw new Error(`${label}: tray click`);
    },
    menu: () => [
      {
        label: "Boom",
        click: () => {
          ran.menuItem = true;
          throw new Error(`${label}: tray menu item`);
        },
      },
    ],
  });
  const trayWindow = currentTray()!.windowHandle();
  postTrayMouse(trayWindow, TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
  await pumpUntil(() => ran.trayClick, doubleClickTime() + 2000);
  await chooseFirstItem(trayWindow, () => ran.menuItem);
  tray.dispose();

  const win = new Window({
    title: `sweetview compat faults ${label}`,
    noActivate: true,
    onClose: () => {
      ran.onClose = true;
      throw new Error(`${label}: window onClose`);
    },
  });
  user32.SendMessageW(BigInt(win.handle!), WM_CLOSE, 0n, 0n);
  win.dispose();

  // The page calls each method and fetches a dynamic path, awaiting nothing; it reports what came back.
  const page = `<!doctype html><title>compat faults</title><script>
    const rpc = window.__sweetview_rpc;
    const seen = {};
    const note = (name, p) => p.then(() => (seen[name] = "resolved"), (e) => (seen[name] = "rejected: " + (e && e.message)));
    note("ui", rpc("fault.ui", null));
    note("deferred", rpc("fault.deferred", null));
    note("worker", rpc("fault.reject", ${JSON.stringify(label)}));
    fetch("/dynamic").then((r) => (seen.request = r.status));
    rpc("__sweetview.ready", null);
    setTimeout(() => rpc("fault.crash", ${JSON.stringify(label)}), 300);
    setTimeout(() => rpc("fault.seen", seen), 1500);
  </script>`;
  let seen: unknown;
  const app = await createApp({
    title: `sweetview compat faults page ${label}`,
    noActivate: true,
    assets: { "index.html": new TextEncoder().encode(page) },
    worker: new URL("./callback-faults.worker.ts", import.meta.url),
    onRequest: (request) => {
      // The page's fetch; the browser's own requests (its favicon) are answered 404.
      if (!request.url.endsWith("/dynamic")) return { status: 404 };
      ran.onRequest = true;
      throw new Error(`${label}: onRequest`);
    },
    onReady: () => {
      ran.onReady = true;
      throw new Error(`${label}: onReady`);
    },
    uiMethods: {
      "fault.ui": () => {
        ran.uiMethod = true;
        throw new Error(`${label}: uiMethods`);
      },
      "fault.seen": (value: unknown) => void (seen = value),
    },
    deferredUiMethods: {
      "fault.deferred": () => {
        ran.deferredUiMethod = true;
        throw new Error(`${label}: deferredUiMethods`);
      },
    },
  });
  await pumpUntil(() => seen !== undefined, 30_000);
  await pumpUntil(() => false, 300);
  app.dispose();
  return { ran, page: seen };
}

if (mode === "exit") {
  onCallbackError(() => process.exit(3));
  const tray = new Tray({
    tooltip: `sweetview compat faults exit ${process.pid}`,
    onClick: () => {
      throw new Error("exit: tray click");
    },
  });
  postTrayMouse(currentTray()!.windowHandle(), TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
  await pumpUntil(() => false, doubleClickTime() + 3000);
  tray.dispose();
  console.log(JSON.stringify({ exited: false }));
  process.exit(0);
}

const report: Record<string, unknown> = {};

// 1. No listener: as before. Nothing reaches uncaughtException; the parent reads the logged lines.
report.withoutListener = { ...(await throwFromEach("without")), reachedUncaught: reachedUncaught.splice(0) };

// 2. A listener: every kind arrives, with its kind; nothing is printed (the parent checks stderr).
const arrivals: string[] = [];
const off = onCallbackError((error: Error, source: CallbackErrorSource) => {
  arrivals.push(`${source.kind}${source.name ? ` (${source.name})` : ""}: ${error.message}`);
});
report.withListener = { ...(await throwFromEach("with")), arrivals: arrivals.splice(0), reachedUncaught: reachedUncaught.splice(0) };

// A Menu.popup item's click runs inside Menu.popup, after the menu has closed: it is not a callback
// boundary, and its exception comes out of Menu.popup to the code that called it.
{
  const owner = new Window({ title: "sweetview compat faults popup", noActivate: true });
  let thrownFromPopup = "";
  for (let attempt = 1; attempt <= 3 && !thrownFromPopup; attempt++) {
    const watcher = native.scheduleInterval(10, () => {
      const menu = openPopupMenu();
      if (menu === 0n) return;
      native.cancelTimeout(watcher);
      pressKeys(menu, VK.DOWN, VK.RETURN);
    });
    try {
      Menu.popup(owner, [{ label: "Boom", click: () => { throw new Error("popup item"); } }], { x: 200, y: 200 });
    } catch (err) {
      thrownFromPopup = (err as Error).message;
    }
    native.cancelTimeout(watcher);
  }
  owner.dispose();
  report.menuPopup = { thrownFromPopup, arrivals: arrivals.splice(0) };
}
off();

// 3. The application's own uncaughtException listeners, from one onCallbackError listener.
const offEmit = onCallbackError((error) => void process.emit("uncaughtException", error, "uncaughtException"));
{
  let clicked = false;
  const tray = new Tray({
    tooltip: `sweetview compat faults emit ${process.pid}`,
    onClick: () => {
      clicked = true;
      throw new Error("emit: tray click");
    },
  });
  postTrayMouse(currentTray()!.windowHandle(), TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
  await pumpUntil(() => clicked && reachedUncaught.length > 0, doubleClickTime() + 2000);
  tray.dispose();
}
offEmit();
report.emitted = { reachedUncaught: reachedUncaught.splice(0) };

console.log(JSON.stringify(report));
process.exit(0);
