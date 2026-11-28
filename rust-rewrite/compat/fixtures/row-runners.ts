// R2: what runs each row of docs/upgrading.md. upgrade-guide.test.ts reads
// the guide's tables, works out each row's targets from its "Write now"
// column (`new Name` for `new Name(…)`, `Name.member` for a static member,
// `Name#member` for an instance member, `Name` for a call `Name(…)`, a
// constant `Name === …`, or an import with nothing after it), and fails when
// a target has no runner here. Each runner calls its target once in its new
// form with real arguments and throws when what comes back is not what the
// row says; a constant is compared with what the code that uses it sends or
// receives. `here` runners run in the test's own process; `desktop` runners
// need a window, a webview, the tray, the clipboard, a hook, a dialog or the
// event loop, and run in fixtures/rows-desktop.ts, a process of its own.
//
// Rows whose first span is a type (`import type`, `type X = …`) are type
// rows: upgrade-types.ts holds them and tsc checks it. Rows of a `/darwin/`
// module are macOS-only: importing the module loads AppKit, so they are not
// run on Windows.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untilDesktopIsOurs } from "../../../packages/sweetview-native/test/desktop";

/** What a desktop runner gets from rows-desktop.ts. */
export type DesktopCtx = {
  /** The probe of test/win32-os.ts (bun:ffi), loaded in the desktop process only. */
  os: typeof import("../../../packages/sweetview-native/test/win32-os");
  /** A new Window, disposed when the run ends. */
  window(options?: import("@n1h/sweetview-native").WindowOptions): import("@n1h/sweetview-native").Window;
  /** A native Webview in a window of its own, destroyed when the run ends. */
  webview(): import("@n1h/sweetview").RawWebview;
  /** What a page answers to an expression, through a binding of the fixture's own. */
  ask(view: import("@n1h/sweetview").RawWebview, expression: string): Promise<string>;
  until(condition: () => boolean, ms?: number): Promise<boolean>;
  /** The app rows-page.ts runs in, made once with createApp; its page's report. */
  pageApp(): Promise<{ app: import("@n1h/sweetview").App; report: Record<string, any> }>;
  /** What the mouse and keyboard hooks saw of the input this run injected (made once). */
  hookRun(): Promise<{ mouse: number[]; keys: number[]; keyCodes: string[] }>;
  tmp: string;
};
export type HereCtx = { tmp: string };

export type Runner =
  | { where: "here"; run(value: any, ctx: HereCtx): unknown }
  | { where: "desktop"; run(value: any, ctx: DesktopCtx): unknown };

/** Throws with what was seen when `ok` is false. */
export function must(ok: boolean, what: string, seen?: unknown): void {
  if (!ok) throw new Error(`${what}${seen === undefined ? "" : `; seen: ${JSON.stringify(seen, (_, v) => (typeof v === "bigint" ? `${v}n` : v))}`}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const here = (run: (value: any, ctx: HereCtx) => unknown): Runner => ({ where: "here", run });
const desktop = (run: (value: any, ctx: DesktopCtx) => unknown): Runner => ({ where: "desktop", run });

const root = join(import.meta.dir, "..", "..", "..");
const rgba = (size: number, alphaInset = 0) => {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = x >= alphaInset && y >= alphaInset && x < size - alphaInset && y < size - alphaInset;
      out.set([200, 40, 90, inside ? 255 : 0], i);
    }
  }
  return out;
};
/** The image sizes an .ico file holds (its directory; 0 means 256). */
const icoSizes = (ico: Uint8Array) => {
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  must(view.getUint16(0, true) === 0 && view.getUint16(2, true) === 1, "an .ico starts with reserved 0 and type 1", [...ico.subarray(0, 4)]);
  return Array.from({ length: view.getUint16(4, true) }, (_, i) => ico[6 + 16 * i] || 256);
};
/** The four-letter types an .icns file holds. */
const icnsTypes = (icns: Uint8Array) => {
  must(new TextDecoder().decode(icns.subarray(0, 4)) === "icns", "an .icns starts with icns");
  const view = new DataView(icns.buffer, icns.byteOffset, icns.byteLength);
  must(view.getUint32(4) === icns.length, "an .icns states its own length", [view.getUint32(4), icns.length]);
  const types: string[] = [];
  for (let at = 8; at < icns.length; at += view.getUint32(at + 4)) types.push(new TextDecoder().decode(icns.subarray(at, at + 4)));
  return types;
};
const sorted = (sizes: number[]) => [...sizes].sort((a, b) => a - b).join();
const isPng = (bytes: Uint8Array) => same([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const registry = (key: string) => Bun.spawnSync(["reg", "query", key], { stdout: "pipe", stderr: "pipe" });
/**
 * Runs `work` with a notifier app id of the tests' own (`Sweetview.NotifierTest.<uuid>`) and then
 * removes the two registry entries a notifier leaves for it, as notifier.test.ts does: the
 * AppUserModelId key and the notification platform's Notifications\\Settings entry.
 */
const withTestAppId = (work: (appId: string) => unknown) => {
  const appId = `Sweetview.NotifierTest.${crypto.randomUUID()}`;
  try {
    return work(appId);
  } finally {
    Bun.spawnSync(["reg", "delete", `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`, "/f"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["reg", "delete", `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId}`, "/f"], { stdout: "pipe", stderr: "pipe" });
    must(!appIdRegistered(appId), "the test app id is removed from the registry");
  }
};
const appIdRegistered = (appId: string) => registry(`HKCU\\Software\\Classes\\AppUserModelId\\${appId}`).exitCode === 0;
const WS_THICKFRAME = 0x00040000n;
/**
 * MINMAXINFO.ptMaxTrackSize as the window answers WM_GETMINMAXINFO. A probe through bun:ffi, as
 * own-ffi.ts is (test/win32-os.ts reads only the minimum): no Sweetview API reports it. Loaded on
 * call, in the desktop process only.
 */
const maxTrackSize = (hwnd: bigint): [number, number] => {
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const user32 = dlopen("user32.dll", { SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 } });
  try {
    const info = new Int32Array(10);
    user32.symbols.SendMessageW(hwnd, 0x0024, 0n, BigInt(ptr(info))); // WM_GETMINMAXINFO
    return [info[8]!, info[9]!];
  } finally {
    user32.close();
  }
};
const style = (ctx: DesktopCtx, hwnd: bigint) => BigInt(ctx.os.user32.GetWindowLongPtrW(hwnd, ctx.os.GWL_STYLE));
const hwndOf = (win: { handle: unknown }) => BigInt(win.handle as number | bigint);
/** Runs `step` from native timeouts (they fire inside a modal loop) until it returns true or `ms` passed. */
const inModal = async (step: () => boolean, ms = 8000) => {
  const { scheduleNativeTimeout } = await import("../../../packages/sweetview-native/src/internal");
  const end = Date.now() + ms;
  const tick = () => {
    if (!step() && Date.now() < end) scheduleNativeTimeout(25, tick);
  };
  scheduleNativeTimeout(25, tick);
};
/** Loads a page of the webview's own asset origin (so its requests are same-origin) and waits for it. */
const onAssetPage = async (ctx: DesktopCtx, view: import("@n1h/sweetview").RawWebview) => {
  view.setAsset("rows-page.html", "text/html", "<!doctype html><title>rows page</title>");
  view.navigate(`${view.assetOrigin}/rows-page.html`);
  for (let i = 0; i < 40 && (await ctx.ask(view, "document.title").catch(() => "")) !== "rows page"; i++) await Bun.sleep(100);
};
/**
 * Opens a popup menu with `open` and ends it from inside its loop once it is on the screen; what open returned,
 * whether the menu was seen, and the menu window's rectangle on the screen.
 */
const popupRun = async (ctx: DesktopCtx, open: () => unknown) => {
  let seen = false;
  let rect = { left: 0, top: 0, right: 0, bottom: 0 };
  await inModal(() => {
    const menu = ctx.os.openPopupMenu();
    if (menu === 0n) return false;
    seen = true;
    rect = ctx.os.windowRect(menu);
    ctx.os.endMenu();
    return true;
  });
  const result = open();
  return { result, seen, rect };
};
/** The window the native layer made for the tray made last (the Windows backend's own handle). */
const trayWindow = (): bigint => require("../../../packages/sweetview-native/src/win32/tray").currentTray()?.windowHandle() ?? 0n;
const MENU = [{ label: "One", click() {} }, { type: "separator" as const }, { label: "Two", click() {} }];

export const RUNNERS: Record<string, Runner> = {
  // ---- constants ------------------------------------------------------------------------------------
  APP_ICO_SIZES: here(async (value: number[]) => {
    const { icoFromRgba } = await import("@n1h/sweetview-native");
    const sizes = icoSizes(icoFromRgba(32, rgba(32)));
    must(sorted(sizes) === sorted(value), "icoFromRgba writes the APP_ICO_SIZES images by default", { sizes, value });
  }),
  ASSET_ORIGIN: desktop(async (value: string, ctx) => {
    const { report } = await ctx.pageApp();
    must(report.origin === value, "a page loaded from assets has ASSET_ORIGIN as its origin", report.origin);
    must(ctx.webview().assetOrigin === value, "the webview's assetOrigin is ASSET_ORIGIN");
  }),
  FRAMES_ORIGIN: desktop((value: string, ctx) => must(ctx.webview().framesOrigin === value, "the webview's framesOrigin is FRAMES_ORIGIN", ctx.webview().framesOrigin)),
  WEBVIEW_VERSION: here((value: string) => {
    // Nothing sends it: it names the webview library API level the bindings package had.
    must(/^\d+\.\d+\.\d+$/.test(value) && value === "0.12.0", "WEBVIEW_VERSION is the version string 0.12.0", value);
  }),
  "Feature.MouseHook": here(async (e: Record<string, number>) => {
    const value = e.MouseHook!;
    const { permissions } = await import("@n1h/sweetview-native");
    must(same(permissions.needed(value), []) && permissions.ready(value), "on Windows the mouse hook needs no permission and is ready");
  }),
  "Feature.KeyboardHook": here(async (e: Record<string, number>) => {
    const value = e.KeyboardHook!;
    const { permissions } = await import("@n1h/sweetview-native");
    must(same(permissions.needed(value), []) && permissions.ready(value), "on Windows the keyboard hook needs no permission and is ready");
  }),
  permissions: here(async (value) => {
    const { Feature, Permission } = await import("@n1h/sweetview-native");
    const was = value.autoRequest;
    value.autoRequest = was;
    must(
      same(value.needed(Feature.KeyboardHook), []) && value.status(Permission.InputMonitoring) === "not-applicable" && value.ready(Feature.MouseHook) && value.autoRequest === was,
      "Windows: no feature needs a permission, none applies, every feature is ready",
    );
  }),
  "Permission.DeviceControl": here(async (e: Record<string, number>) => {
    const value = e.DeviceControl!;
    const { permissions } = await import("@n1h/sweetview-native");
    must(permissions.status(value) === "not-applicable", "the native layer takes the bit and says Windows has no such permission", permissions.status(value));
  }),
  "Permission.InputMonitoring": here(async (e: Record<string, number>) => {
    const value = e.InputMonitoring!;
    const { permissions } = await import("@n1h/sweetview-native");
    must(permissions.status(value) === "not-applicable", "the native layer takes the bit and says Windows has no such permission", permissions.status(value));
  }),
  ...Object.fromEntries(
    (["Shift", "Control", "Alt", "Meta"] as const).map((key) => [
      `Modifier.${key}`,
      here(async (e: Record<string, number>) => {
        const value = e[key]!;
        const { modifiersFrom } = await import("@n1h/sweetview-native");
        const field = { Shift: "shift", Control: "ctrl", Alt: "alt", Meta: "meta" }[key];
        const got = modifiersFrom(value);
        must(Object.entries(got).every(([k, v]) => v === (k === field)), `the mask Modifier.${key} is the ${field} key alone`, got);
      }),
    ]),
  ),
  ...Object.fromEntries(
    (["Down", "Up", "Repeat"] as const).map((name) => [
      `KeyEvent.${name}`,
      desktop(async (e: Record<string, number>, ctx) => {
        const value = e[name]!;
        const { keys } = await ctx.hookRun();
        // Injected: F24 down, down again (held: a repeat), up.
        must(same(keys, [0, 2, 1]) && keys.includes(value), `the keyboard hook reports KeyEvent.${name} for an injected F24`, keys);
      }),
    ]),
  ),
  ...Object.fromEntries(
    (["Move", "LeftDown", "LeftUp", "RightDown", "RightUp", "MiddleDown", "MiddleUp", "Wheel"] as const).map((name) => [
      `MouseEvent.${name}`,
      desktop(async (e: Record<string, number>, ctx) => {
        const value = e[name]!;
        const { mouse } = await ctx.hookRun();
        must(mouse.includes(value), `the mouse hook reports MouseEvent.${name} for injected input`, mouse);
      }),
    ]),
  ),
  ...Object.fromEntries(
    (["NONE", "MIN", "MAX", "FIXED"] as const).map((name) => [
      `SizeHint.${name}`,
      desktop(async (e: Record<string, number>, ctx) => {
        const value = e[name]!;
        const { Window } = require("@n1h/sweetview-native");
        const view = ctx.webview();
        const hwnd = BigInt(view.unsafeWindowHandle!);
        view.size = { width: 400, height: 300, hint: value };
        const win = Window.fromHandle(hwnd);
        const thick = (style(ctx, hwnd) & WS_THICKFRAME) !== 0n;
        const minTrack = ctx.os.minTrackSize(hwnd);
        const at = win.bounds();
        const maxTrack = maxTrackSize(hwnd);
        // Maximised, a window grows past the size given (the OS sizes a maximised window by the work area).
        win.show();
        win.toggleMaximize();
        await ctx.until(() => ctx.os.user32.IsZoomed(hwnd) !== 0, 2000);
        const grown = win.bounds();
        win.toggleMaximize();
        win.dispose();
        const frame = { width: minTrack[0] - 400, height: minTrack[1] - 300 };
        const seen = { thick, minTrack, maxTrack, at, grown };
        if (name === "FIXED") must(!thick, "FIXED: the window cannot be resized", seen);
        else must(thick, `${name}: the window can be resized`, seen);
        // The size given is the page's: the outer track sizes add the frame (under 80 px either way).
        if (name === "MIN") must(frame.width >= 0 && frame.width < 80 && frame.height >= 0 && frame.height < 80, "MIN: the minimum track size is the size given plus the frame", seen);
        const maxFrame = { width: maxTrack[0] - 400, height: maxTrack[1] - 300 };
        if (name === "MAX") must(maxFrame.width >= 0 && maxFrame.width < 80 && maxFrame.height >= 0 && maxFrame.height < 80, "MAX: the maximum track size is the size given plus the frame", seen);
        else must(maxTrack[0] === 0 || maxTrack[0] > 400 + 80, `${name}: no maximum at the size`, seen);
        if (name === "NONE") must(minTrack[0] < 400 && grown.width > 400 + 80, "NONE: no minimum at the size, and maximised it grows past it", seen);
      }),
    ]),
  ),

  // ---- objects and classes -----------------------------------------------------------------------------
  Clipboard: desktop((value, ctx) => RUNNERS["Clipboard.writeText"]!.run(value, ctx as never)),
  "Clipboard.readText": desktop((value, ctx) => RUNNERS["Clipboard.writeText"]!.run(value, ctx as never)),
  "Clipboard.writeText": desktop((value) => {
    const before = value.readText();
    const marker = `sweetview compat ${process.pid} ${Date.now()}`;
    try {
      value.writeText(marker);
      must(value.readText() === marker, "readText gives back what writeText put on the clipboard");
    } finally {
      // Put the text back for the people and sessions sharing this desktop.
      value.writeText(before ?? "");
    }
  }),
  Screen: desktop((value, ctx) => RUNNERS["Screen.primary"]!.run(value, ctx as never)),
  "Screen.primary": desktop((value, ctx) => {
    const p = value.primary();
    const sm = (i: number) => ctx.os.user32.GetSystemMetrics(i);
    must(p.bounds.x === 0 && p.bounds.y === 0 && p.bounds.width === sm(0) && p.bounds.height === sm(1), "the primary screen is the OS's primary screen at the origin", p.bounds);
  }),
  "Screen.all": desktop((value, ctx) => {
    const all = value.all();
    must(all.length === ctx.os.user32.GetSystemMetrics(80) && all.some((s: any) => s.bounds.x === 0 && s.bounds.y === 0), "one screen per monitor (SM_CMONITORS), the primary among them", all.length); // SM_CMONITORS
  }),
  "Screen.at": desktop((value) => {
    const s = value.at({ x: 10, y: 10 });
    must(s.bounds.x <= 10 && s.bounds.y <= 10 && s.bounds.x + s.bounds.width > 10, "the screen at a point contains the point", s.bounds);
  }),
  "Screen.of": desktop((value, ctx) => {
    const win = ctx.window({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    const s = value.of(win);
    must(s.bounds.x <= 100 && s.bounds.y <= 100 && s.scale > 0, "the screen of a window holds it", s);
  }),
  "Screen.bounds": desktop((value, ctx) => {
    const b = value.bounds();
    const sm = (i: number) => ctx.os.user32.GetSystemMetrics(i);
    must(same([b.x, b.y, b.width, b.height], [sm(76), sm(77), sm(78), sm(79)]), "Screen.bounds is the virtual screen", b);
  }),
  "Screen.cursor": desktop((value, ctx) => {
    const c = value.cursor();
    const os = ctx.os.cursor();
    must(Math.abs(c.x - os.x) <= 2 && Math.abs(c.y - os.y) <= 2, "the cursor where GetCursorPos says", { c, os });
  }),
  "new HitRelay": desktop((value, ctx) => {
    const calls: unknown[] = [];
    const relay = new value({ setHitRegions: (p: unknown, refine: unknown) => calls.push([p, typeof refine]) }, () => {});
    relay.setRegions([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]]);
    must(calls.length === 1 && Array.isArray((calls[0] as unknown[])[0]) && (calls[0] as unknown[])[1] === "function", "a HitRelay hands its regions and a refiner to the window", calls);
    void ctx;
  }),
  "HitRelay#setRegions": desktop(async (value, ctx) => {
    const win = ctx.window({ frame: false, bounds: { x: 50, y: 50, width: 200, height: 200 } });
    const relay = new value(win, () => {});
    relay.setRegions([[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]]);
    must(relay.isEnabled(), "a relay is on when made");
  }),
  "HitRelay#answer": desktop((value) => {
    let reply: boolean | undefined;
    let refine: ((p: { x: number; y: number }, r: (solid: boolean) => void) => void) | undefined;
    const probes: { id: number }[] = [];
    const relay = new value({ setHitRegions: (_p: unknown, r: typeof refine) => (refine = r) }, (q: { id: number }) => probes.push(q));
    relay.apply();
    refine!({ x: 3, y: 4 }, (solid) => (reply = solid));
    relay.answer({ id: probes[0]!.id + 1, solid: true }); // not the latest probe: dropped
    must(reply === undefined, "an answer to another probe is dropped");
    relay.answer({ id: probes[0]!.id, solid: true });
    must(reply === true && same(probes[0], { id: probes[0]!.id, x: 3, y: 4 }), "the answer to the latest probe reaches the window", { probes, reply });
  }),
  "HitRelay#setEnabled": desktop((value) => {
    const sent: unknown[] = [];
    const relay = new value({ setHitRegions: (p: unknown) => sent.push(p) }, () => {});
    relay.setRegions([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]]);
    relay.setEnabled(false);
    must(sent.at(-1) === null && !relay.isEnabled(), "off: the window gets no regions", sent);
  }),
  "HitRelay#isEnabled": desktop((value) => {
    const relay = new value({ setHitRegions() {} }, () => {});
    must(relay.isEnabled() === true, "on by default");
  }),
  "HitRelay#apply": desktop((value) => {
    const sent: unknown[] = [];
    const relay = new value({ setHitRegions: (p: unknown) => sent.push(p) }, () => {});
    relay.apply();
    must(same(sent, [[]]), "apply re-sends the current regions", sent);
  }),
  Menu: desktop((value, ctx) => RUNNERS["Menu.popup"]!.run(value, ctx as never)),
  "Menu.popup": desktop(async (value, ctx) => {
    const owner = ctx.window();
    const { result, seen } = await popupRun(ctx, () => value.popup(owner, MENU, { x: 40, y: 40 }));
    must(seen && result === false, "the menu opened and, dismissed, chose nothing", { seen, result });
    // Owned by a raw handle (the popupMenu row's `popupMenu(owner.handle, template, at)`).
    const byHandle = await popupRun(ctx, () => value.popup(owner.handle, MENU, { x: 50, y: 50 }));
    must(byHandle.seen && byHandle.result === false, "owned by a raw handle, the menu opened and, dismissed, chose nothing", byHandle);
    // At the cursor, owned by a tabbed window's frame (the showTabPopupMenu row's `showTabPopupMenu(frame, template)`).
    const tabbed = ctx.window({ tabs: true });
    tabbed.show();
    const onFrame = await popupRun(ctx, () => value.popup(tabbed, MENU));
    must(onFrame.seen && onFrame.result === false, "at the cursor, owned by a tabbed window's frame, the menu opened and, dismissed, chose nothing", onFrame);
    // `{ above: true }` (the popupMenuAtCursor row's public form): the menu's bottom-left corner at the point.
    // The middle of the primary work area, so the OS moves the menu neither way.
    const area = (await import("@n1h/sweetview-native")).Screen.primary().workArea;
    const at = { x: area.x + (area.width >> 1), y: area.y + (area.height >> 1) };
    const above = await popupRun(ctx, () => value.popup(owner, MENU, at, { above: true }));
    must(above.seen && above.result === false && above.rect.left === at.x && above.rect.bottom === at.y && above.rect.top < at.y, "with { above: true } the menu opens above the point", { at, ...above });
  }),
  "new Notifier": desktop((value) =>
    withTestAppId((appId) => {
      const notifier = new value({ appId });
      try {
        must(notifier instanceof value && typeof notifier.notify === "function", "a Notifier, with notify");
      } finally {
        notifier.dispose();
        notifier.dispose(); // safe twice
      }
    }),
  ),
  "Notifier#notify": desktop((value) =>
    withTestAppId((appId) => {
      // The public notify is `this.#inner.notify(n)`, and only the backend behind it holds the
      // native notifier whose toast life can be shortened: a toast shown with the default life puts
      // a banner on the shared desktop that stays while nobody is at it. So the backend the method
      // forwards to is made and called here, with a life of 4 s (the toast goes to the notification
      // centre with no banner, and expires).
      const { createNotifier, debugNativeNotifier } = require("../../../packages/sweetview-native/src/win32/notifier");
      const backend = createNotifier({ appId });
      try {
        debugNativeNotifier(backend)!.debugSetToastLife(4);
        must(typeof value.prototype.notify === "function", "Notifier#notify is a method");
        const shown = backend.notify({ title: "Sweetview compat test", body: "a row of the upgrade guide", silent: true, id: `compat-${process.pid}` });
        must(shown === true, "notify shows the toast", shown);
      } finally {
        backend.dispose();
      }
    }),
  ),
  "new RawWebview": desktop((value, ctx) => {
    const host = ctx.window({ bounds: { x: 60, y: 60, width: 320, height: 240 } });
    const view = new value(false, undefined, host.handle);
    try {
      must(typeof view.unsafeHandle === "number" && BigInt(view.unsafeWindowHandle) !== 0n, "a webview in the given window", view.unsafeHandle);
      const wrapped = new value(view.unsafeHandle);
      must(wrapped.unsafeHandle === view.unsafeHandle, "new RawWebview(handle) wraps the same webview");
    } finally {
      view.destroy();
    }
  }),
  "RawWebview#setBackgroundColor": desktop((_value, ctx) => {
    const view = ctx.webview();
    view.setBackgroundColor(10, 20, 30, 255);
    must(view.unsafeHandle !== null, "the webview takes a background colour");
  }),
  "RawWebview#setAsset": desktop(async (_value, ctx) => {
    const view = ctx.webview();
    view.setAsset("compat.txt", "text/plain", "asset text");
    await onAssetPage(ctx, view);
    must((await ctx.ask(view, `fetch("${view.assetOrigin}/compat.txt").then((r) => r.text())`)) === "asset text", "the page fetches the asset");
  }),
  "RawWebview#setRequestHandler": desktop(async (_value, ctx) => {
    const view = ctx.webview();
    view.setRequestHandler((req) => ({ status: 200, headers: { "content-type": "text/plain" }, body: `handled ${new URL(req.url).pathname}` }));
    await onAssetPage(ctx, view);
    const text = await ctx.ask(view, `fetch("${view.assetOrigin}/by-handler").then((r) => r.text())`);
    must(text === "handled /by-handler", "the page's request is answered by the handler", text);
  }),
  "RawWebview#beginResponse": desktop(async (_value, ctx) => {
    const view = ctx.webview();
    view.setRequestHandler((req) => {
      view.beginResponse(req.id, { status: 200, headers: { "content-type": "text/plain" } });
      view.writeResponseChunk(req.id, "streamed ");
      view.writeResponseChunk(req.id, "by method");
      view.endResponse(req.id);
    });
    await onAssetPage(ctx, view);
    const text = await ctx.ask(view, `fetch("${view.assetOrigin}/stream").then((r) => r.text())`);
    must(text === "streamed by method", "the streamed answer reaches the page", text);
  }),
  "RawWebview#setFileDropHandler": desktop((_value, ctx) => {
    // A real drop reaching the handler with its path is proven in Rust (crates/sweetview-platform-webview/
    // tests/file_drop.rs); here the call reaches the webview, set and cleared.
    const view = ctx.webview();
    view.setFileDropHandler(() => {});
    view.setFileDropHandler(null);
    must(view.unsafeHandle !== null, "the webview takes the handler and its removal");
  }),
  "RawWebview#setAllowExternalDrop": desktop((_value, ctx) => {
    const view = ctx.webview();
    view.setAllowExternalDrop(false);
    view.setAllowExternalDrop(true);
    must(view.unsafeHandle !== null, "the webview takes the setting both ways");
  }),
  "new Ring": here(async (value) => {
    const sab = value.create(64);
    const ring = new value(sab);
    must(ring.capacity === 64, "a ring over a 64-byte buffer holds 64 bytes", ring.capacity);
  }),
  "new SettingsStore": here((value, ctx) => {
    const dir = join(ctx.tmp, "settings-class");
    const store = new value({ app: "compat", dir, defaults: { volume: 3, name: "x" } });
    must(same(store.load(), { volume: 3, name: "x" }), "missing file: the defaults");
    store.save({ volume: 7, name: "y" });
    must(existsSync(store.path) && same(new value({ app: "compat", dir, defaults: { volume: 3, name: "x" } }).load(), { volume: 7, name: "y" }), "what was saved loads back");
  }),
  "new Tray": desktop((value, ctx) => {
    const { dotIco } = require("@n1h/sweetview-native");
    const tray = new value({ tooltip: `sweetview compat ${process.pid}`, icon: { windows: { ico: dotIco() } } });
    const hwnd = trayWindow();
    try {
      must(hwnd !== 0n && ctx.os.isWindow(hwnd), "the tray has its window", hwnd);
    } finally {
      tray.dispose();
    }
    must(!ctx.os.isWindow(hwnd), "dispose removes the tray and its window");
  }),
  "WebView.attach": desktop(async (value, ctx) => {
    const win = ctx.window({ bounds: { x: 80, y: 80, width: 400, height: 300 } });
    const view = await value.attach(win, { assets: { "index.html": new TextEncoder().encode("<!doctype html><title>attached</title>") } });
    try {
      must(view.window === win && view.raw.unsafeHandle !== null, "the webview is attached to the window", view.window === win);
    } finally {
      view.dispose();
    }
  }),
  "RawWebview#destroy": desktop((value) => {
    const view = new value(false);
    view.destroy();
    must(view.unsafeHandle === null && view.unsafeWindowHandle === null, "after destroy the handles are null");
  }),
  "RawWebview#unsafeHandle": desktop((_value, ctx) => must(Number.isSafeInteger(ctx.webview().unsafeHandle), "an opaque safe integer")),
  "RawWebview#unsafeWindowHandle": desktop((_value, ctx) => must(ctx.os.isWindow(BigInt(ctx.webview().unsafeWindowHandle!)), "a real HWND")),
  "RawWebview#bindRaw": desktop(async (_value, ctx) => {
    const view = ctx.webview();
    const arg = { token: 1 };
    let seen: unknown;
    view.bindRaw("compatRow", (seq: string, req: string, a: unknown) => {
      seen = { req, same: a === arg };
      view.return(seq, 0, '"ok"');
    }, arg);
    view.setHTML("<!doctype html><script>window.compatRow(5)</script>");
    await ctx.until(() => seen !== undefined, 8000);
    must(same(seen, { req: "[5]", same: true }), "the page's call reaches the callback with the value given", seen);
  }),
  "new WebviewError": here((value) => {
    const err = new value("webview_create", -1);
    must(err instanceof Error && (err as any).fn === "webview_create" && (err as any).code === -1, "fn and code kept", err.message);
  }),
  "new Window": desktop((value, ctx) => {
    const win = new value({ title: `compat ${process.pid}`, bounds: { x: 70, y: 70, width: 300, height: 200 } });
    try {
      must(ctx.os.isWindow(hwndOf(win)) && same(win.bounds(), { x: 70, y: 70, width: 300, height: 200 }), "a window at the bounds given", win.bounds());
    } finally {
      win.dispose();
    }
  }),
  "Window.fromHandle": desktop((value, ctx) => {
    const own = ctx.window({ bounds: { x: 90, y: 90, width: 320, height: 200 } });
    const wrapped = value.fromHandle(own.handle);
    must(same(wrapped.bounds(), own.bounds()), "the wrapper reads the same window", wrapped.bounds());
    wrapped.dispose();
    must(ctx.os.isWindow(hwndOf(own)), "disposing a wrapper leaves the window");
  }),
  "Window#handle": desktop((_value, ctx) => must(ctx.os.isWindow(hwndOf(ctx.window())), "the real HWND")),
  "Window#isVisible": desktop((_value, ctx) => {
    const win = ctx.window();
    must(!win.isVisible(), "made hidden");
    win.show();
    must(win.isVisible() && ctx.os.user32.IsWindowVisible(hwndOf(win)) !== 0, "visible after show");
  }),
  "Window#show": desktop((_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    must(ctx.os.user32.IsWindowVisible(hwndOf(win)) !== 0, "the OS shows it");
  }),
  "Window#hide": desktop((_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    win.hide();
    must(ctx.os.user32.IsWindowVisible(hwndOf(win)) === 0, "the OS hides it");
  }),
  "Window#toggle": desktop((_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.toggle();
    const shown = ctx.os.user32.IsWindowVisible(hwndOf(win)) !== 0;
    win.toggle();
    must(shown && ctx.os.user32.IsWindowVisible(hwndOf(win)) === 0, "shown, then hidden");
  }),
  "Window#setIcon": desktop((_value, ctx) => {
    const { dotIco } = require("@n1h/sweetview-native");
    const win = ctx.window();
    win.setIcon({ windows: { ico: dotIco() } });
    must(ctx.os.user32.SendMessageW(hwndOf(win), ctx.os.WM_GETICON, ctx.os.ICON_BIG, 0n) !== 0n, "the window has the icon");
  }),
  "Window#onClose": desktop(async (_value, ctx) => {
    const win = ctx.window();
    let asked = 0;
    win.onClose(() => asked++);
    ctx.os.post(hwndOf(win), ctx.os.WM_CLOSE);
    await ctx.until(() => asked > 0, 2000);
    must(asked === 1 && ctx.os.isWindow(hwndOf(win)), "the listener is asked and the window stays", asked);
  }),
  "Window#bounds": desktop((_value, ctx) => {
    const win = ctx.window({ bounds: { x: 110, y: 120, width: 330, height: 220 } });
    const r = ctx.os.windowRect(hwndOf(win));
    must(same(win.bounds(), { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }), "the outer rectangle the OS has", win.bounds());
  }),
  "Window#moveTo": desktop((_value, ctx) => {
    const win = ctx.window({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    win.moveTo(140, 150);
    must(ctx.os.windowRect(hwndOf(win)).left === 140 && ctx.os.windowRect(hwndOf(win)).top === 150, "moved", ctx.os.windowRect(hwndOf(win)));
  }),
  "Window#resize": desktop((_value, ctx) => {
    const win = ctx.window({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    win.resize(360, 240);
    const r = ctx.os.windowRect(hwndOf(win));
    must(r.right - r.left === 360 && r.bottom - r.top === 240, "resized", r);
  }),
  "Window#setBounds": desktop((_value, ctx) => {
    const win = ctx.window();
    win.setBounds({ x: 130, y: 140, width: 350, height: 250 });
    const r = ctx.os.windowRect(hwndOf(win));
    must(same([r.left, r.top, r.right - r.left, r.bottom - r.top], [130, 140, 350, 250]), "placed", r);
  }),
  "Window#setClickThrough": desktop((_value, ctx) => {
    const win = ctx.window({ frame: false, transparent: true, bounds: { x: 100, y: 100, width: 200, height: 200 } });
    win.setClickThrough(true);
    const ex = BigInt(ctx.os.user32.GetWindowLongPtrW(hwndOf(win), ctx.os.GWL_EXSTYLE));
    must((ex & 0x20n) !== 0n, "WS_EX_TRANSPARENT: clicks pass through", ex.toString(16)); // WS_EX_TRANSPARENT
    win.setClickThrough(false);
    must((BigInt(ctx.os.user32.GetWindowLongPtrW(hwndOf(win), ctx.os.GWL_EXSTYLE)) & 0x20n) === 0n, "and back");
  }),
  "Window#setHitRegions": desktop((_value, ctx) => {
    // What the poll does with the cursor is proven in Rust (window_os_tests.rs,
    // the_hit_region_poll_follows_the_real_cursor_with_and_without_a_refiner); here the call reaches the
    // window: no polygon makes the whole window let clicks through at once, null gives normal hit testing back.
    const win = ctx.window({ frame: false, bounds: { x: 260, y: 240, width: 300, height: 200 } });
    const passing = () => (BigInt(ctx.os.user32.GetWindowLongPtrW(hwndOf(win), ctx.os.GWL_EXSTYLE)) & 0x20n) !== 0n; // WS_EX_TRANSPARENT
    win.setHitRegions([]);
    const through = passing();
    win.setHitRegions(null);
    must(through && !passing(), "no polygon lets clicks through, null gives them back", { through });
  }),
  "Window#setTopmost": desktop((_value, ctx) => {
    const win = ctx.window();
    win.setTopmost(true);
    must((BigInt(ctx.os.user32.GetWindowLongPtrW(hwndOf(win), ctx.os.GWL_EXSTYLE)) & 0x8n) !== 0n, "WS_EX_TOPMOST");
    win.setTopmost(false);
  }),
  "Window#startDrag": desktop(async (_value, ctx) => {
    const win = ctx.window({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    // A button held on the shared desktop is waited out, and a row it never lets run fails as not run.
    await untilDesktopIsOurs("every mouse button up on the shared desktop", () => !ctx.os.buttonsDown());
    win.startDrag();
    must(same(win.bounds(), { x: 100, y: 100, width: 300, height: 200 }), "with the button up, no drag starts", win.bounds());
  }),
  "Window#startResize": desktop(async (_value, ctx) => {
    const win = ctx.window({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    // A button held on the shared desktop is waited out, and a row it never lets run fails as not run.
    await untilDesktopIsOurs("every mouse button up on the shared desktop", () => !ctx.os.buttonsDown());
    win.startResize("bottom-right");
    must(same(win.bounds(), { x: 100, y: 100, width: 300, height: 200 }), "with the button up, no resize starts", win.bounds());
  }),
  "Window#minimize": desktop(async (_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    win.minimize();
    must(await ctx.until(() => ctx.os.user32.IsIconic(hwndOf(win)) !== 0, 2000), "IsIconic");
  }),
  "Window#toggleMaximize": desktop(async (_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    win.toggleMaximize();
    const zoomed = await ctx.until(() => ctx.os.user32.IsZoomed(hwndOf(win)) !== 0, 2000);
    win.toggleMaximize();
    must(zoomed && (await ctx.until(() => ctx.os.user32.IsZoomed(hwndOf(win)) === 0, 2000)), "maximised, then restored");
  }),
  "Window#onMaximizeChange": desktop(async (_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    const seen: boolean[] = [];
    const off = win.onMaximizeChange((maximized: boolean) => seen.push(maximized));
    win.show();
    win.toggleMaximize();
    await ctx.until(() => seen.length === 1, 2000);
    win.toggleMaximize();
    await ctx.until(() => seen.length === 2, 2000);
    off();
    win.toggleMaximize();
    must(same(seen, [true, false]) && ctx.os.user32.IsZoomed(hwndOf(win)) !== 0, "maximised and restored, each reported once; nothing after unsubscribing", seen);
  }),
  "Window#showSystemMenu": desktop(async (_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    const { result, seen } = await popupRun(ctx, () => win.showSystemMenu());
    must(seen && result === undefined && !ctx.os.user32.IsIconic(hwndOf(win)) && win.isVisible(), "the system menu opened and, dismissed, did nothing", { seen });
    // The windowMenu row's `windowMenu(hwnd)`: a window the application made itself, outside Sweetview (bun:ffi),
    // wrapped once, its system menu opened several times through that one wrapper. Nothing accumulates per call,
    // and disposing the wrapper leaves the window.
    const { Window } = await import("@n1h/sweetview-native");
    const { _debugTrackedCount } = await import("../../../packages/sweetview-native/src/win32/window");
    // A top-level window on the screen with a title bar and a system menu, as an application's own is.
    const WS_VISIBLE = 0x10000000;
    const WS_CAPTION = 0x00c00000;
    const WS_SYSMENU = 0x00080000;
    const WS_THICKFRAME = 0x00040000;
    const WS_MINIMIZEBOX = 0x00020000;
    const WS_MAXIMIZEBOX = 0x00010000;
    const own: bigint = ctx.os.user32.CreateWindowExW(0, ctx.os.wide("STATIC"), ctx.os.wide(`sweetview compat own window ${process.pid}`), WS_VISIBLE | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX, 220, 220, 320, 200, 0n, 0n, ctx.os.hInstance(), null);
    must(own !== 0n, "the application's own window was made");
    try {
      const wrapped = Window.fromHandle(own);
      const kept = _debugTrackedCount(own);
      const opens: { seen: boolean; result: unknown; kept: number }[] = [];
      for (let i = 0; i < 3; i++) {
        const { seen: opened, result: chose } = await popupRun(ctx, () => wrapped.showSystemMenu());
        opens.push({ seen: opened, result: chose, kept: _debugTrackedCount(own) });
      }
      must(kept >= 1 && opens.every((o) => o.seen && o.result === undefined && o.kept === kept), "each time, the system menu of the application's own window opened through the one wrapper, and nothing more was kept", { kept, opens });
      // A command chosen from it is carried out: a second process selects Minimize (the fourth item)
      // and presses Enter on the menu window (posted messages, no input injected).
      const probe = join(root, "packages", "sweetview", "test", "fixtures", "win-menu-probe.ts");
      const picker = Bun.spawn([process.execPath, probe, String(process.pid), "pick:3"], { stdout: "pipe", stderr: "pipe" });
      wrapped.showSystemMenu();
      await picker.exited;
      const picked = JSON.parse((await new Response(picker.stdout).text()).trim() || "{}") as { error?: string; items?: unknown[] };
      await ctx.until(() => ctx.os.user32.IsIconic(own) !== 0, 3000);
      must(picked.error === undefined && picked.items !== undefined && ctx.os.user32.IsIconic(own) !== 0, "Minimize chosen from the system menu minimised the application's own window", picked);
      wrapped.dispose();
      must(_debugTrackedCount(own) === 0 && ctx.os.isWindow(own), "disposing the wrapper keeps nothing for the window and leaves it", _debugTrackedCount(own));
    } finally {
      ctx.os.user32.DestroyWindow(own);
    }
  }),
  "Window#isMaximized": desktop(async (_value, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    must(!win.isMaximized(), "not maximised");
    win.toggleMaximize();
    await ctx.until(() => win.isMaximized(), 2000);
    must(win.isMaximized() === (ctx.os.user32.IsZoomed(hwndOf(win)) !== 0) && win.isMaximized(), "IsZoomed");
  }),
  "Window#scale": desktop(async (_value, ctx) => {
    // The page's devicePixelRatio is the scale the OS gives the window, read by the browser engine.
    const { Window } = require("@n1h/sweetview-native");
    const view = ctx.webview();
    view.setHTML("<!doctype html><title>x</title>");
    await Bun.sleep(300);
    const win = Window.fromHandle(BigInt(view.unsafeWindowHandle!));
    const ratio = Number(await ctx.ask(view, "devicePixelRatio"));
    const scale = win.scale();
    win.dispose();
    must(Math.abs(scale - ratio) < 0.01, "the window's DPI over 96, as the page's devicePixelRatio", { scale, ratio });
  }),
  "Window#dispose": desktop((value, ctx) => {
    const win = new value();
    const hwnd = hwndOf(win);
    win.dispose();
    must(!ctx.os.isWindow(hwnd), "the window is destroyed");
    void ctx;
  }),
  "Window#onFileDrop": desktop((_value, ctx) => {
    const win = ctx.window();
    const got: string[][] = [];
    win.onFileDrop((paths: string[]) => got.push(paths));
    ctx.os.sendDrop(hwndOf(win), ["C:\\compat\\one.txt"]);
    must(same(got, [["C:\\compat\\one.txt"]]), "WM_DROPFILES reaches the listener", got);
  }),
  "Window#onMove": desktop(async (_value, ctx) => {
    const win = ctx.window({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    const got: unknown[] = [];
    win.onMove((b: unknown) => got.push(b));
    win.moveTo(150, 160);
    await ctx.until(() => got.length > 0, 2000);
    must(got.length > 0 && (got.at(-1) as { x: number }).x === 150, "the move is reported", got);
  }),
  "Window#onResize": desktop(async (_value, ctx) => {
    const win = ctx.window({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    const got: unknown[] = [];
    win.onResize((b: unknown) => got.push(b));
    win.resize(340, 230);
    await ctx.until(() => got.length > 0, 2000);
    must(got.length > 0 && (got.at(-1) as { width: number }).width === 340, "the resize is reported", got);
  }),
  "Window#setTitle": desktop((_value, ctx) => {
    const win = ctx.window();
    win.setTitle("compat title");
    const text = new Uint16Array(64);
    const n = ctx.os.user32.GetWindowTextW(hwndOf(win), text, 64);
    must(String.fromCharCode(...text.subarray(0, n)) === "compat title", "GetWindowText");
  }),

  // ---- functions: the UI thread, windows and webviews ----------------------------------------------------------
  resolveMenu: here((fn) => {
    const template = [{ label: "A", click() {} }];
    must(fn(template) === template && fn(() => template) === template && same(fn(undefined), []), "a template, a function of one, or nothing");
  }),
  createWindow: desktop((fn, ctx) => {
    const { Window } = require("@n1h/sweetview-native");
    const win = fn({ bounds: { x: 100, y: 100, width: 250, height: 180 } });
    try {
      must(win instanceof Window && ctx.os.isWindow(hwndOf(win)), "a Window");
    } finally {
      win.dispose();
    }
  }),
  closeToTrayOnLastWindow: desktop(async (fn, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    let hidden = 0;
    const off = fn(win, () => hidden++);
    ctx.os.post(hwndOf(win), ctx.os.WM_CLOSE);
    await ctx.until(() => hidden > 0, 2000);
    off();
    must(hidden === 1 && ctx.os.isWindow(hwndOf(win)) && !win.isVisible(), "the last visible window is hidden, not closed", { hidden });
  }),
  createHitRelay: desktop((fn, ctx) => {
    const { HitRelay } = require("@n1h/sweetview-native");
    const win = ctx.window({ frame: false });
    const relay = fn(win, () => {});
    must(relay instanceof HitRelay && relay.isEnabled(), "a HitRelay for the window");
  }),
  createNotifier: desktop((fn) =>
    withTestAppId((appId) => {
      const { Notifier } = require("@n1h/sweetview-native");
      const notifier = fn({ appId });
      try {
        must(notifier instanceof Notifier, "a Notifier");
      } finally {
        notifier.dispose();
      }
    }),
  ),
  createTray: desktop((fn, ctx) => {
    const tray = fn({ tooltip: `sweetview compat ${process.pid}` });
    const hwnd = trayWindow();
    tray.dispose();
    must(hwnd !== 0n && !ctx.os.isWindow(hwnd), "a tray with its window, gone after dispose");
  }),
  pickFolder: desktop(async (fn, ctx) => {
    const owner = ctx.window();
    const folder = mkdtempSync(join(ctx.tmp, "pick-"));
    const title = `sweetview compat folder ${process.pid}`;
    let typed = false;
    await inModal(() => {
      const dialog = ctx.os.ownWindows("#32770", title)[0] ?? 0n;
      if (dialog === 0n) return false;
      typed = ctx.os.chooseInFolderDialog(dialog, folder);
      return typed;
    }, 10_000);
    // Never left open: closed from inside its loop after the limit.
    const { scheduleNativeTimeout } = await import("../../../packages/sweetview-native/src/internal");
    const stop = scheduleNativeTimeout(12_000, () => void ctx.os.ownWindows("#32770", title).forEach((d) => ctx.os.post(d, ctx.os.WM_CLOSE)));
    const picked = fn(owner, title);
    stop();
    must(typed && picked?.toLowerCase() === require("node:fs").realpathSync.native(folder).toLowerCase(), "the folder chosen in the dialog", { typed, picked });
  }),
  installMouseHook: desktop(async (_fn, ctx) => {
    const { mouse } = await ctx.hookRun();
    must(mouse.length >= 8, "the hook saw the injected mouse input", mouse);
  }),
  installKeyboardHook: desktop(async (_fn, ctx) => {
    const { keys, keyCodes } = await ctx.hookRun();
    must(keys.length === 3 && keyCodes.every((c) => c === "F24"), "the hook saw the injected F24", { keys, keyCodes });
  }),
  pumpEvents: desktop((fn) => must(fn() === true, "true while no quit was asked for")),
  // runEventLoop and quitEventLoop are the run's own loop (rows-desktop.ts records them).
  runEventLoop: desktop(() => "recorded by rows-desktop.ts"),
  quitEventLoop: desktop(() => "recorded by rows-desktop.ts"),
  setActivationPolicy: desktop((fn) => {
    for (const policy of ["regular", "accessory", "prohibited"]) must(fn(policy) === undefined, "Windows: nothing to set");
  }),
  setAppIcon: desktop((fn) => {
    const { dotIco } = require("@n1h/sweetview-native");
    must(fn({ windows: { ico: dotIco() } }) === undefined, "Windows: nothing to set at run time");
  }),
  setAppMenu: desktop((fn) => must(fn({ appName: "compat", aboutText: "compat" }) === undefined, "Windows: no app menu bar")),
  unload: here((fn) => must(fn() === undefined, "with no live webview it does nothing")),
  completeWebviewRequest: desktop((fn, ctx) => RUNNERS.endWebviewResponse!.run(fn, { ...ctx, complete: fn } as never)),
  beginWebviewResponse: desktop((fn, ctx) => RUNNERS.endWebviewResponse!.run(fn, ctx as never)),
  writeWebviewResponseChunk: desktop((fn, ctx) => RUNNERS.endWebviewResponse!.run(fn, ctx as never)),
  endWebviewResponse: desktop(async (_fn, ctx) => {
    const { beginWebviewResponse, writeWebviewResponseChunk, endWebviewResponse, completeWebviewRequest } = require("@n1h/sweetview");
    const view = ctx.webview();
    view.setRequestHandler((req: { id: bigint; url: string }) => {
      const handle = view.unsafeHandle!;
      if (req.url.endsWith("/complete")) return void completeWebviewRequest(handle, req.id, { status: 200, headers: { "content-type": "text/plain" }, body: "completed" });
      beginWebviewResponse(handle, req.id, { status: 200, headers: { "content-type": "text/plain" } });
      writeWebviewResponseChunk(handle, req.id, "chunk one, ");
      writeWebviewResponseChunk(handle, req.id, new TextEncoder().encode("chunk two"));
      endWebviewResponse(handle, req.id);
    });
    await onAssetPage(ctx, view);
    const streamed = await ctx.ask(view, `fetch("${view.assetOrigin}/stream").then((r) => r.text())`);
    const completed = await ctx.ask(view, `fetch("${view.assetOrigin}/complete").then((r) => r.text())`);
    must(streamed === "chunk one, chunk two" && completed === "completed", "the worker functions answer the page's requests", { streamed, completed });
  }),

  // ---- functions: the app, its page and its worker ------------------------------------------------------------------
  createApp: desktop(async (fn, ctx) => {
    const { app, report } = await ctx.pageApp();
    must(typeof fn === "function" && app.webview !== undefined && report.isWebview === true, "an app whose page runs", report);
  }),
  windowChromeMethods: desktop(async (fn, ctx) => {
    const win = ctx.window({ noActivate: true });
    win.show();
    const methods = fn(win, { chrome: "page" });
    methods["window.minimize"]();
    must(same(methods["window.info"](), { chrome: "page", maximized: false }) && (await ctx.until(() => ctx.os.user32.IsIconic(hwndOf(win)) !== 0, 2000)), "window.info and window.minimize act on the window");
  }),
  windowChromeControls: desktop(async (_fn, ctx) => {
    const { app, report } = await ctx.pageApp();
    must(same(report.chromeInfo, { chrome: "page", maximized: false }), "the page asks the window through the controls", report.chromeInfo);
    must(await ctx.until(() => ctx.os.user32.IsIconic(hwndOf(app.window)) !== 0, 3000), "the page's minimise reaches the window");
  }),
  isWebview: desktop(async (fn, ctx) => {
    must(fn() === false, "false in Bun");
    must((await ctx.pageApp()).report.isWebview === true, "true in the page");
  }),
  webviewTransport: desktop(async (_fn, ctx) => must((await ctx.pageApp()).report.workerEcho === "worker: from the page", "the page's call over the transport", (await ctx.pageApp()).report.workerEcho)),
  signalReady: desktop(async (fn, ctx) => {
    // The page module's form (in the page) and the native one (here, on the UI thread).
    if (fn === require("@n1h/sweetview/page").signalReady) {
      must((await ctx.pageApp()).report.signalReady === "resolved", "the page's signalReady resolves");
      return;
    }
    const { emitActivationUrl } = require("../../../packages/sweetview-native/src/internal");
    const { onOpenUrl: listen } = require("@n1h/sweetview-native");
    const got: string[] = [];
    const off = listen((url: string) => got.push(url));
    emitActivationUrl("sweetview-compat-row://buffered");
    fn();
    off();
    must(same(got, ["sweetview-compat-row://buffered"]), "the URL waits for signalReady and is then delivered", got);
  }),
  onOpenUrl: desktop((fn) => {
    const { emitActivationUrl } = require("../../../packages/sweetview-native/src/internal");
    const { signalReady } = require("@n1h/sweetview-native");
    signalReady();
    const got: string[] = [];
    const off = fn((url: string) => got.push(url));
    emitActivationUrl("sweetview-compat-row://open");
    off();
    must(same(got, ["sweetview-compat-row://open"]), "the handler gets the URL", got);
  }),
  singleInstance: desktop(async (fn) => {
    // The handoff of a second instance is proven in Rust (single_instance.rs,
    // a_secondary_process_hands_off_to_this_primary) and its delivery to onSecondInstance in
    // callbacks.test.ts; here the first instance is primary and its lock goes.
    const lock = await fn({ appId: `sweetview.compat.rows.${process.pid}`, args: [], onSecondInstance: () => {} });
    try {
      must(lock.isPrimary === true, "the first instance is primary");
    } finally {
      lock.dispose();
    }
  }),
  hostService: desktop(async (_fn, ctx) => must((await ctx.pageApp()).report.workerEcho === "worker: from the page", "the worker's service answers the page", (await ctx.pageApp()).report.workerEcho)),
  hostRequestHandler: desktop(async (_fn, ctx) => must((await ctx.pageApp()).report.workerRequest === "worker answered /rows-dynamic", "the worker answers the page's request", (await ctx.pageApp()).report.workerRequest)),
  wsUrl: desktop(async (fn, ctx) => {
    const { report } = await ctx.pageApp();
    must(report.wsUrl === `ws://${new URL(report.origin).host}/sock` && typeof fn === "function", "ws:// on the page's own host", report.wsUrl);
  }),

  // ---- functions with no OS state --------------------------------------------------------------------------------------
  appDataDir: here((fn) => must(fn("compat-app") === join(process.env.APPDATA ?? "", "compat-app"), "under %APPDATA%", fn("compat-app"))),
  assetMime: here((fn) => must(fn("main.js").includes("javascript") && fn("index.html").startsWith("text/html") && fn("x.unknownext") === "application/octet-stream", "by extension", fn("main.js"))),
  extractUrlFromArgs: here((fn) => {
    must(fn(["--flag", "myapp://open/1"], ["myapp"]) === "myapp://open/1" && fn(["https://x.example"]) === undefined && fn(["other://x"], ["myapp"]) === undefined, "the first argument with a scheme asked for");
  }),
  validateUrlScheme: here((fn) => {
    must(fn(" MyApp ") === "myapp", "trimmed and lowercased");
    let threw = false;
    try {
      fn("1bad");
    } catch {
      threw = true;
    }
    must(threw, "an invalid scheme throws");
  }),
  defineAppIdentity: here((fn) => {
    const id = fn({ appId: "com.example.compat-app", appName: "Compat App", urlSchemes: ["CompatApp"] });
    must(id.slug === "compat-app" && same(id.urlSchemes, ["compatapp"]) && id.version === "0.1.0" && Object.isFrozen(id), "slug, schemes and version filled in", id);
  }),
  createSettingsStore: here((fn, ctx) => {
    const store = fn({ app: "compat", dir: join(ctx.tmp, "settings-fn"), defaults: { on: false } });
    store.save({ on: true });
    must(same(store.load(), { on: true }), "saved and loaded");
  }),
  registerUrlScheme: here((fn) => {
    const { unregisterUrlScheme } = require("@n1h/sweetview-native");
    const scheme = `sweetview-compat-${process.pid}`;
    try {
      fn(scheme, { name: "Sweetview compat test" });
      must(registry(`HKCU\\Software\\Classes\\${scheme}`).exitCode === 0, "the scheme is registered for the user");
    } finally {
      // Never left behind on this machine.
      unregisterUrlScheme(scheme);
    }
    must(registry(`HKCU\\Software\\Classes\\${scheme}`).exitCode !== 0, "and removed again");
  }),
  unregisterUrlScheme: here((fn) => {
    const { registerUrlScheme } = require("@n1h/sweetview-native");
    const scheme = `sweetview-compat-un-${process.pid}`;
    registerUrlScheme(scheme);
    fn(scheme);
    must(registry(`HKCU\\Software\\Classes\\${scheme}`).exitCode !== 0, "the scheme is gone from the registry");
  }),
  readTextFile: here(async (fn, ctx) => {
    const file = join(ctx.tmp, "text.txt");
    writeFileSync(file, "héllo");
    must((await fn(file)) === "héllo", "the file's text");
  }),
  readFileBytes: here(async (fn, ctx) => {
    const file = join(ctx.tmp, "bytes.bin");
    writeFileSync(file, new Uint8Array([1, 2, 3]));
    must(same([...(await fn(file))], [1, 2, 3]), "the file's bytes");
  }),
  openFileHandle: here((fn, ctx) => RUNNERS.readFileChunk!.run(fn, ctx as never)),
  closeFileHandle: here((fn, ctx) => RUNNERS.readFileChunk!.run(fn, ctx as never)),
  readFileChunk: here((_fn, ctx) => {
    const { openFileHandle, readFileChunk, closeFileHandle } = require("@n1h/sweetview-native");
    const file = join(ctx.tmp, "chunk.bin");
    writeFileSync(file, "0123456789");
    const { handleId, size } = openFileHandle(file);
    const chunk = readFileChunk(handleId, 2, 4);
    closeFileHandle(handleId);
    let closed = false;
    try {
      readFileChunk(handleId, 0, 1);
    } catch {
      closed = true;
    }
    must(size === 10 && new TextDecoder().decode(chunk.data) === "2345" && chunk.bytesRead === 4 && !chunk.eof && closed, "a chunk of the file; closed after", { size, chunk, closed });
  }),
  closeAllFileHandles: here((fn, ctx) => {
    const { openFileHandle, readFileChunk } = require("@n1h/sweetview-native");
    const file = join(ctx.tmp, "all.bin");
    writeFileSync(file, "x");
    const { handleId } = openFileHandle(file);
    fn();
    let closed = false;
    try {
      readFileChunk(handleId, 0, 1);
    } catch {
      closed = true;
    }
    must(closed, "every handle is closed");
  }),
  indexHtml: here(async (fn) => {
    const text = await fn({ title: "T" }).text();
    must(text.includes("<title>T</title>") && text.includes("main.js") && text.includes("main.css"), "the page with its title, script and style", text);
  }),
  indexHtmlText: here((fn) => must(fn({ title: "T", body: "<p>b</p>" }).includes("<p>b</p>"), "the page as text")),
  resizeHandles: here((fn) => {
    const handles = fn(4);
    must(handles.length === 8 && handles[0].edge === "top" && handles[0].style.height === 4, "eight handles of the thickness given", handles[0]);
  }),
  makeMacApp: here((fn, ctx) => {
    const binary = join(ctx.tmp, "compat-binary");
    writeFileSync(binary, "not a real binary");
    const app = fn({ name: "Compat", bundleId: "com.example.compat", binary, outDir: ctx.tmp, sign: false });
    must(existsSync(join(app, "Contents", "Info.plist")) && readFileSync(join(app, "Contents", "Info.plist"), "utf8").includes("com.example.compat"), "a bundle with its Info.plist", app);
  }),
  writeIconFiles: here((fn, ctx) => {
    const { dotIco, dotIcns } = require("@n1h/sweetview-native");
    const written = fn(join(ctx.tmp, "icons"), { ico: dotIco(), icns: dotIcns() });
    must(written.length === 2 && written.every((p: string) => existsSync(p)), "app.ico and AppIcon.icns", written);
  }),
  refreshWindowsIcons: here((fn) => must(fn() === undefined, "the shell is told; nothing on the computer changes")),
  modifiersFrom: here((fn) => must(same(fn(0b0101), { shift: true, ctrl: false, alt: true, meta: false }), "the mask's keys")),
  convexHull: here((fn) => {
    const hull = fn([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    must(hull.length === 4 && !hull.some((p: { x: number; y: number }) => p.x === 5 && p.y === 5), "the inner point is not on the hull", hull);
  }),
  flattenRegions: here((fn) => must(same(fn([[{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]]), [3, 1, 2, 3, 4, 5, 6]), "count then the points", fn([[{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]]))),
  unpackRegions: here((fn) => must(same(fn([3, 1, 2, 3, 4, 5, 6]), [[{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]]), "the polygons back")),
  packRegions: here((fn) => {
    const packed = fn([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]]);
    must(packed instanceof Int32Array && same([...packed.subarray(0, 5)], [3, 0, 0, 10, 10]), "count and bounds first", [...packed]);
  }),
  hitRegions: here((fn) => {
    const { packRegions } = require("@n1h/sweetview-native");
    const packed = packRegions([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]]);
    must(fn(packed, 2, 2) === true && fn(packed, 9, 9) === false, "inside the triangle, outside it");
  }),
  createBridge: here(async (fn) => {
    const { defineService, memoryTransport } = require("@n1h/sweetview-ipc");
    const bridge = fn(memoryTransport(defineService(() => ({ methods: { add: ([a, b]: number[]) => a! + b! } }))));
    must((await bridge.rpc("add", [2, 3])) === 5, "a typed call over the transport");
  }),
  defineService: here(async (fn) => {
    const service = fn((emit: (n: string, p: unknown) => void) => ({ methods: { ping: () => (emit("pinged", 1), "pong") } }));
    const events: unknown[] = [];
    service.onEvent((n: string, p: unknown) => events.push([n, p]));
    must((await service.call("ping", null, { session: { id: "s", kind: "web" } })) === "pong" && same(events, [["pinged", 1]]), "a method and an event", events);
  }),
  memoryTransport: here(async (fn) => {
    const { defineService } = require("@n1h/sweetview-ipc");
    const transport = fn(defineService(() => ({ methods: { two: () => 2 } })));
    must((await transport.call("two", null)) === 2, "a call straight onto the service");
    transport.dispose();
  }),
  createFrameAssembler: here((fn) => {
    const assembler = fn();
    const frame = { kind: "event", name: "e", payload: "x".repeat(10) };
    const b64 = Buffer.from(JSON.stringify(frame)).toString("base64");
    const half = Math.ceil(b64.length / 2);
    must(assembler.push({ kind: "chunk", id: 1, index: 0, total: 2, data: b64.slice(0, half) }) === null, "waits for the rest");
    must(same(assembler.push({ kind: "chunk", id: 1, index: 1, total: 2, data: b64.slice(half) }), frame), "the frame whole");
  }),
  wsHost: here(async (fn) => {
    const { defineService } = require("@n1h/sweetview-ipc");
    const { wsTransport } = require("@n1h/sweetview-ipc-ws");
    const host = fn(defineService(() => ({ methods: { hi: (n: string) => `hi ${n}` } })));
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => (host.upgrade(req, srv) ? undefined : new Response("no")), websocket: host.websocket });
    try {
      const transport = wsTransport(`ws://127.0.0.1:${server.port}/ws`);
      await transport.ready;
      must((await transport.call("hi", "ws")) === "hi ws" && host.sessions === 1, "a call over a WebSocket");
      transport.dispose();
    } finally {
      host.dispose();
      server.stop(true);
    }
  }),
  wsTransport: here((_fn, ctx) => RUNNERS.wsHost!.run(require("@n1h/sweetview-ipc-ws").wsHost, ctx as never)),
  writeWorkerFrame: here((fn) => {
    const { Ring } = require("@n1h/sweetview");
    const sab = Ring.create(256);
    let woke = 0;
    fn(new Ring(sab), { kind: "event", name: "e", payload: 1 }, () => woke++);
    const length = new DataView(sab, 16).getUint32(0, true);
    const frame = JSON.parse(new TextDecoder().decode(new Uint8Array(sab, 20, length)));
    must(same(frame, { kind: "event", name: "e", payload: 1 }) && woke === 1, "the frame is in the ring and the UI thread woken", { frame, woke });
  }),
  writeWorkerCrash: here((fn) => {
    const { Ring } = require("@n1h/sweetview");
    const sab = Ring.create(256);
    let woke = 0;
    const ok = fn(new Ring(sab), "boom", () => woke++);
    const length = new DataView(sab, 16).getUint32(0, true);
    const frame = JSON.parse(new TextDecoder().decode(new Uint8Array(sab, 20, length)));
    must(ok && same(frame, { kind: "workerError", message: "boom" }), "the crash frame is in the ring", frame);
  }),

  // ---- icons -------------------------------------------------------------------------------------------------------------------------
  renderDot: here((fn) => {
    const px = fn(16);
    must(px.length === 16 * 16 * 4 && px[(8 * 16 + 8) * 4 + 3] === 255 && px[3] === 0, "an opaque dot on a clear square", px.length);
  }),
  dotPng: here((fn) => {
    const { decodePng } = require("@n1h/sweetview-native");
    const png = fn(32);
    must(isPng(png) && decodePng(png).width === 32, "a 32 px PNG");
  }),
  dotIco: here((fn) => must(sorted(icoSizes(fn({ sizes: [16, 32] }))) === "16,32", "an .ico with the sizes asked for", icoSizes(fn({ sizes: [16, 32] })))),
  dotIcns: here((fn) => must(icnsTypes(fn()).length > 0, "an .icns with images", icnsTypes(fn()))),
  encodePng: here((fn) => {
    const { decodePng } = require("@n1h/sweetview-native");
    const back = decodePng(fn(4, rgba(4)));
    must(back.width === 4 && back.height === 4 && same([...back.rgba.subarray(0, 4)], [200, 40, 90, 255]), "decodes to the same pixels", back.width);
  }),
  decodePng: here((fn) => {
    const { encodePng } = require("@n1h/sweetview-native");
    const back = fn(encodePng(2, rgba(2)));
    must(back.width === 2 && back.rgba.length === 16, "width, height and RGBA", back.width);
  }),
  encodeIco: here((fn) => {
    const { encodePng } = require("@n1h/sweetview-native");
    must(sorted(icoSizes(fn(new Map([[16, encodePng(16, rgba(16))], [32, encodePng(32, rgba(32))]])))) === "16,32", "an .ico of the images given");
  }),
  encodeIcns: here((fn) => {
    const { encodePng } = require("@n1h/sweetview-native");
    must(icnsTypes(fn(new Map([[32, encodePng(32, rgba(32))]]))).length === 1, "an .icns of the image given");
  }),
  icoFromPng: here((fn) => {
    const { encodePng } = require("@n1h/sweetview-native");
    must(sorted(icoSizes(fn(encodePng(64, rgba(64)), [16, 48]))) === "16,48", "an .ico in the sizes asked for");
  }),
  icnsFromPng: here((fn) => {
    const { encodePng } = require("@n1h/sweetview-native");
    must(icnsTypes(fn(encodePng(64, rgba(64)), [16, 32])).length === 2, "an .icns in the sizes asked for");
  }),
  icoFromRgba: here((fn) => must(sorted(icoSizes(fn(32, rgba(32), [16, 32]))) === "16,32", "an .ico in the sizes asked for")),
  icnsFromRgba: here((fn) => must(icnsTypes(fn(32, rgba(32), [16, 32])).length === 2, "an .icns in the sizes asked for")),
  trimTransparent: here((fn) => {
    const trimmed = fn({ width: 16, height: 16, rgba: rgba(16, 4) }, 0, 8);
    must(trimmed.width === 8 && trimmed.height === 8, "the clear border is cut off", { width: trimmed.width, height: trimmed.height });
  }),
};


/** A scratch folder for one run, removed with `dispose`. */
export function scratch(): { tmp: string; dispose(): void } {
  const tmp = mkdtempSync(join(tmpdir(), "sweetview-compat-rows-"));
  return { tmp, dispose: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** The Old names of rows another change owns, whose runners come with that change. None now: the menu rows have theirs above. */
export const ROWS_OF_ANOTHER_CHANGE = new Set<string>();
