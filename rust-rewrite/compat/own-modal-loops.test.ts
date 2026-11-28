// W4.8: an application's own bun:ffi modal dialog and popup menu work inside
// Sweetview's event loop in both of its modes. First as the item states it:
// opened from a `uiMethods` method of an app made with `createApp`, called
// from its page, with the page's UI and worker calls answered inside each
// loop (fixtures/app-modals.ts). Then from a plain handler on the UI thread,
// while a native timeout still fires and a wake still drains inside the loop.
//
// The dialog is closed by a native timeout posting WM_CLOSE to it; the menu
// is dismissed by a native timeout calling EndMenu, the documented way to
// end a menu's modal loop.

import { describe, expect, test } from "bun:test";
import { FFIType, dlopen } from "bun:ffi";
import { quitEventLoop, runEventLoop, Window } from "@n1h/sweetview-native";
import { scheduleNativeTimeout } from "../../packages/sweetview-native/src/internal";
import { binding } from "../../packages/sweetview-native/src/binding";

const onWindows = process.platform === "win32";

const user32 = onWindows
  ? dlopen("user32.dll", {
      MessageBoxW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
      PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
      CreatePopupMenu: { args: [], returns: FFIType.u64 },
      AppendMenuW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      TrackPopupMenu: { args: [FFIType.u64, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      DestroyMenu: { args: [FFIType.u64], returns: FFIType.i32 },
      EndMenu: { args: [], returns: FFIType.i32 },
    }).symbols
  : undefined;

const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const WM_CLOSE = 0x0010;
const TPM_RETURNCMD = 0x0100;
const TPM_NONOTIFY = 0x0080;

type Seen = string[];

/** Opens the dialog, then the menu, each closed from inside its own modal loop by a native timeout. */
function openOwnModals(owner: bigint, label: string, seen: Seen, token: number): void {
  const native = binding();
  native.setDrain(token, () => seen.push(`${label}: drained`));

  const title = `sweetview compat ${label} ${process.pid}`;
  scheduleNativeTimeout(40, () => {
    seen.push(`${label}: timeout inside the dialog`);
    native.wake(token);
  });
  scheduleNativeTimeout(120, () => {
    const dialog = user32!.FindWindowW(wide("#32770"), wide(title));
    seen.push(dialog === 0n ? `${label}: no dialog` : `${label}: closing the dialog`);
    if (dialog !== 0n) user32!.PostMessageW(dialog, WM_CLOSE, 0n, 0n);
  });
  user32!.MessageBoxW(0n, wide("Closed by the test."), wide(title), 0);
  seen.push(`${label}: dialog returned`);

  const menu = user32!.CreatePopupMenu();
  user32!.AppendMenuW(menu, 0, 1n, wide("One"));
  scheduleNativeTimeout(40, () => {
    seen.push(`${label}: timeout inside the menu`);
    native.wake(token);
  });
  scheduleNativeTimeout(120, () => {
    seen.push(`${label}: ending the menu`);
    user32!.EndMenu();
  });
  const chosen = user32!.TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY, -2900, -2900, 0, owner, null);
  user32!.DestroyMenu(menu);
  seen.push(`${label}: menu returned ${chosen}`);
  native.setDrain(token, null);
}

function expected(label: string): string[] {
  return [
    `${label}: timeout inside the dialog`,
    `${label}: drained`,
    `${label}: closing the dialog`,
    `${label}: dialog returned`,
    `${label}: timeout inside the menu`,
    `${label}: drained`,
    `${label}: ending the menu`,
    `${label}: menu returned 0`,
  ];
}

// The same two modal loops opened from `uiMethods` of an app made with `createApp`, called from its
// page (fixtures/app-modals.ts, a process per loop mode with its own WebView2 profile): inside each
// loop the page's calls to a UI method and to a worker method are answered, and the page reports
// each answer back while the loop is still open.
async function appModals(mode: "blocking" | "pumped") {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const profile = mkdtempSync(join(tmpdir(), "sweetview-compat-modals-"));
  try {
    const fixture = fileURLToPath(new URL("./fixtures/app-modals.ts", import.meta.url));
    const proc = Bun.spawn([process.execPath, fixture, mode], { env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile }, stdout: "pipe", stderr: "pipe", timeout: 50_000 });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    if (code !== 0 || !line) throw new Error(`app-modals ${mode}: exit ${code}\n${stdout}\n${stderr}`);
    return JSON.parse(line.slice("RESULT ".length));
  } finally {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
}

describe.if(onWindows)("an application's own modal dialog and popup menu, opened from a uiMethods call of createApp's app, called from its page", () => {
  for (const mode of ["blocking", "pumped"] as const) {
    test(`${mode === "blocking" ? "under app.run()" : "under runEventLoop()"}: inside each loop the page's UI calls and worker calls are answered and the answers reach the page`, async () => {
      const r = await appModals(mode);
      expect(r).toMatchObject({ mode, timedOut: false, finished: true, boxReturned: true, menuReturned: 0 });
      for (const kind of ["box", "menu"] as const) {
        expect(r.inside[kind].uiCalls).toBeGreaterThanOrEqual(3);
        expect(r.inside[kind].uiAnswersSeenByPage).toBeGreaterThanOrEqual(3);
        expect(r.inside[kind].workerAnswersSeenByPage).toBeGreaterThanOrEqual(3);
      }
    }, 60_000);
  }
});

describe.if(onWindows)("an application's own modal dialog and popup menu inside Sweetview's loop", () => {
  test("under the Bun-timer loop (runEventLoop)", async () => {
    const owner = new Window({ title: `compat owner pumped ${process.pid}`, frame: false, noActivate: true, bounds: { x: -3000, y: -3000, width: 80, height: 80 } });
    const seen: Seen = [];
    try {
      owner.show();
      const loop = runEventLoop({ intervalMs: 4 });
      scheduleNativeTimeout(10, () => {
        openOwnModals(BigInt(owner.handle!), "pumped", seen, 7801);
        quitEventLoop();
      });
      await loop;
      expect(seen).toEqual(expected("pumped"));
    } finally {
      owner.dispose();
    }
  });

  test("under the blocking loop", () => {
    const native = binding();
    const owner = new Window({ title: `compat owner blocking ${process.pid}`, frame: false, noActivate: true, bounds: { x: -3000, y: -3000, width: 80, height: 80 } });
    const seen: Seen = [];
    try {
      owner.show();
      let blocking = false;
      scheduleNativeTimeout(10, () => {
        blocking = native.isLoopBlocking();
        openOwnModals(BigInt(owner.handle!), "blocking", seen, 7802);
        native.quitLoop();
      });
      const watchdog = native.scheduleTimeout(10_000, () => native.quitLoop());
      native.runLoop();
      native.cancelTimeout(watchdog);
      expect(blocking).toBe(true);
      expect(seen).toEqual(expected("blocking"));
    } finally {
      owner.dispose();
    }
  });
});
