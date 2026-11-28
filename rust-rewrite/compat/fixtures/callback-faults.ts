// "What changed for every application" and step A of docs/upgrading.md, and "Exceptions thrown by
// your callbacks" in docs/native.md, run for real: an exception thrown by an application's handler
// on the UI thread is caught by Sweetview and never reaches `process.on("uncaughtException")`. A
// tray click, a tray menu item's click and a `Window` `onClose` listener are logged on stderr with
// the stated messages; a `deferredUiMethods` method that throws becomes the page call's rejected
// reply, which a page that does not await it never reads, and nothing is printed. An application
// that replaces `console.error` receives the logged ones, with the error. The documented wrapper,
// `reported`, delivers every one of them to the application's `uncaughtException` listeners, and an
// application whose listener exits ends the process from inside the call.
//
// Each callback is driven by what the OS would deliver, posted to this process's own windows: the
// shell's tray messages, keys posted to the open menu's window, WM_CLOSE. No input is injected.
//
//   bun callback-faults.ts            prints one JSON line; the parent reads stderr too
//   bun callback-faults.ts exit       the listener calls process.exit(3) from inside a tray click

import { createApp } from "@n1h/sweetview";
import { Menu, Tray, Window } from "@n1h/sweetview/native";
import { binding } from "../../../packages/sweetview-native/src/binding";
import { currentTray } from "../../../packages/sweetview-native/src/win32/tray";
import { TRAY, VK, WM_CLOSE, doubleClickTime, openPopupMenu, postTrayMouse, pressKeys, user32 } from "../../../packages/sweetview-native/test/win32-os";

// The wrapper of docs/native.md, "Exceptions thrown by your callbacks", as an application copies it.
// upgrade-guide's behaviour test checks this block is the documented one, character for character.
// --- reported: begin ---
/**
 * Wraps a handler Sweetview calls (a click, a listener, a UI-thread method). An exception it throws
 * goes to the process's "uncaughtException" listeners, as an unhandled exception would, then on to
 * Sweetview as before (logged; a page call is rejected; a hook lets the event through).
 */
function reported<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    try {
      return handler(...args);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!process.emit("uncaughtException", error, "uncaughtException")) console.error(error);
      throw err;
    }
  };
}
// --- reported: end ---

const native = binding();
const mode = process.argv[2] ?? "report";
const reached: string[] = [];
process.on("uncaughtException", (err) => {
  reached.push(err.message);
  if (mode === "exit") process.exit(3);
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
    await pumpUntil(() => chosen() || false, 3000);
    native.cancelTimeout(watcher);
    await pumpUntil(() => openPopupMenu() === 0n, 1000);
  }
  return chosen();
}

type Wrap = <A extends unknown[], R>(handler: (...args: A) => R) => (...args: A) => R;

/** Throws from each kind once, through `wrap`; returns what ran. */
async function throwFromEach(label: string, wrap: Wrap): Promise<Record<string, boolean>> {
  const ran = { trayClick: false, menuItem: false, onClose: false, deferredUiMethod: false };

  const tray = new Tray({
    tooltip: `sweetview compat faults ${label} ${process.pid}`,
    onClick: wrap(() => {
      ran.trayClick = true;
      throw new Error(`${label}: tray click`);
    }),
    menu: () => [
      {
        label: "Boom",
        click: wrap(() => {
          ran.menuItem = true;
          throw new Error(`${label}: tray menu item`);
        }),
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
    onClose: wrap(() => {
      ran.onClose = true;
      throw new Error(`${label}: window onClose`);
    }),
  });
  user32.SendMessageW(BigInt(win.handle!), WM_CLOSE, 0n, 0n);
  win.dispose();

  // The page calls the method and does not await the call.
  const page = `<!doctype html><title>compat faults</title><script>window.__sweetview_rpc("fault.deferred", null);</script>`;
  const app = await createApp({
    title: `sweetview compat faults page ${label}`,
    noActivate: true,
    assets: { "index.html": new TextEncoder().encode(page) },
    deferredUiMethods: {
      "fault.deferred": wrap(() => {
        ran.deferredUiMethod = true;
        throw new Error(`${label}: deferredUiMethods`);
      }),
    },
  });
  await pumpUntil(() => ran.deferredUiMethod, 20_000);
  await pumpUntil(() => false, 200); // the rejected reply goes back to the page
  app.dispose();
  return ran;
}

const identity: Wrap = (handler) => handler;

if (mode === "exit") {
  const tray = new Tray({
    tooltip: `sweetview compat faults exit ${process.pid}`,
    onClick: reported(() => {
      throw new Error("exit: tray click");
    }),
  });
  postTrayMouse(currentTray()!.windowHandle(), TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
  await pumpUntil(() => false, doubleClickTime() + 3000);
  tray.dispose();
  console.log(JSON.stringify({ exited: false }));
  process.exit(0);
}

const report: Record<string, unknown> = {};

// 1. Unwrapped: Sweetview catches each one; none reaches the listener. stderr has the logged lines.
report.unwrapped = { ran: await throwFromEach("unwrapped", identity), reached: reached.splice(0) };

// Menu.popup runs the chosen item's click after the menu has closed, inside Menu.popup: its
// exception comes out of Menu.popup, to the code that called it.
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
  report.menuPopup = { thrownFromPopup, reached: reached.splice(0) };
}

// 2. An application that replaces console.error receives what Sweetview logs, with the error.
const logged: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => void logged.push(`${String(args[0])} ${args[1] instanceof Error ? `[Error] ${args[1].message}` : String(args[1])}`);
const ranWithConsole = await throwFromEach("console", identity);
console.error = originalError;
report.consoleError = { ran: ranWithConsole, logged, reached: reached.splice(0) };

// 3. Wrapped with `reported`: each one reaches the listener.
report.reported = { ran: await throwFromEach("reported", reported), reached: reached.splice(0) };

console.log(JSON.stringify(report));
process.exit(0);
