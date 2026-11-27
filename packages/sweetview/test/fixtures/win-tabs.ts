// Live fixture for src/tabs/win-tabs.test.ts: tabbed windows on Windows, run
// in a process of its own with its own WebView2 profile. Each behaviour of
// "Behaviour: tabs on Windows" it can reach without a person is exercised,
// and what the OS reports back is read with bun:ffi (a probe: no Sweetview
// API reports these OS facts). Prints `RESULT <json>`: one entry per check,
// each `{ ok, detail }`, or `{ skipped }` for a check that needs this
// process's window to be the foreground window and it is not.

import { FFIType, dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebView, type Tab } from "../../src/index";
import { Window, quitEventLoop, runEventLoop, type TabHandle } from "@n1h/sweetview-native";
import { getTabFrame } from "@n1h/sweetview-native/win32/tab-window";
import { engineOf, scheduleNativeTimeout } from "@n1h/sweetview-native/internal";
import { writeSync } from "node:fs";
import { endMenu, openPopupMenu } from "../../../sweetview-native/test/win32-os";
import type { Key } from "@n1h/sweetview-native/win32/shortcuts";
import { STRIP_HEIGHT } from "@n1h/sweetview-native/win32/strip-shared";
import { _debugWinTabs, mergeAllWindows } from "../../src/tabs/win-tabs";

const { u64, u32, i32 } = FFIType;
const user32 = dlopen("user32.dll", {
  GetWindowLongPtrW: { args: [u64, i32], returns: FFIType.i64 },
  GetWindowRect: { args: [u64, FFIType.ptr], returns: i32 },
  GetClientRect: { args: [u64, FFIType.ptr], returns: i32 },
  ClientToScreen: { args: [u64, FFIType.ptr], returns: i32 },
  ScreenToClient: { args: [u64, FFIType.ptr], returns: i32 },
  GetWindow: { args: [u64, u32], returns: u64 },
  GetClassNameW: { args: [u64, FFIType.ptr, i32], returns: i32 },
  IsWindowVisible: { args: [u64], returns: i32 },
  IsWindow: { args: [u64], returns: i32 },
  IsIconic: { args: [u64], returns: i32 },
  IsZoomed: { args: [u64], returns: i32 },
  SendMessageW: { args: [u64, u32, u64, FFIType.i64], returns: FFIType.i64 },
  GetSystemMenu: { args: [u64, i32], returns: u64 },
  GetDpiForWindow: { args: [u64], returns: u32 },
  GetSystemMetricsForDpi: { args: [i32, u32], returns: i32 },
  MonitorFromWindow: { args: [u64, u32], returns: u64 },
  GetMonitorInfoW: { args: [u64, FFIType.ptr], returns: i32 },
  GetForegroundWindow: { args: [], returns: u64 },
  GetLayeredWindowAttributes: { args: [u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: i32 },
  WindowFromPoint: { args: [u64], returns: u64 },
  GetAncestor: { args: [u64, u32], returns: u64 },
  GetDC: { args: [u64], returns: u64 },
  ReleaseDC: { args: [u64, u64], returns: i32 },
}).symbols;
const gdi32 = dlopen("gdi32.dll", { GetPixel: { args: [u64, i32, i32], returns: u32 } }).symbols;
const kernel32 = dlopen("kernel32.dll", {
  GlobalAlloc: { args: [u32, u64], returns: u64 },
  GlobalLock: { args: [u64], returns: FFIType.ptr },
  GlobalUnlock: { args: [u64], returns: i32 },
  GlobalSize: { args: [u64], returns: u64 },
}).symbols;
const dwmapi = dlopen("dwmapi.dll", { DwmGetWindowAttribute: { args: [u64, u32, FFIType.ptr, u32], returns: i32 } }).symbols;

const WS_CAPTION = 0x00c00000n;
const WS_SYSMENU = 0x00080000n;
const WS_THICKFRAME = 0x00040000n;
const WS_MINIMIZEBOX = 0x00020000n;
const WS_MAXIMIZEBOX = 0x00010000n;
const WS_CLIPCHILDREN = 0x02000000n;
const WS_EX_TOPMOST = 0x8n;
const WS_EX_TOOLWINDOW = 0x80n;
const WS_EX_LAYERED = 0x80000n;
const WS_EX_NOACTIVATE = 0x08000000n;
const WM_GETMINMAXINFO = 0x0024;
const WM_NCHITTEST = 0x0084;
const WM_DROPFILES = 0x0233;
const WM_DPICHANGED = 0x02e0;

type Rect = { x: number; y: number; width: number; height: number };
type Check = { ok: boolean; detail?: unknown } | { skipped: string };
const results: Record<string, Check> = {};
/** One line per check as it happens, written straight to stderr, so a killed run shows where it was. */
const say = (line: string) => void writeSync(2, `${line}\n`);
const check = (name: string, ok: boolean, detail?: unknown) => {
  results[name] = { ok, detail };
  say(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const skip = (name: string, why: string) => {
  results[name] = { skipped: why };
  say(`skipped ${name}: ${why}`);
};

const until = async (condition: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (condition()) return true;
  return condition();
};

// What a page answers, through a binding of the fixture's own.
const answers = new Map<number, (value: string) => void>();
const bound = new WeakSet<object>();
let asked = 0;
function ask(view: WebView<any, any>, expression: string): Promise<string> {
  const raw = view.raw;
  if (!bound.has(raw)) {
    bound.add(raw);
    raw.bind("__fixtureAnswer", (id: number, value: string) => answers.get(id)?.(value));
  }
  const id = ++asked;
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no answer to ${expression}`)), 5000);
    answers.set(id, (value) => {
      clearTimeout(timer);
      answers.delete(id);
      done(value);
    });
    raw.eval(`Promise.resolve().then(() => (${expression})).then((v) => __fixtureAnswer(${id}, String(v)), (e) => __fixtureAnswer(${id}, "error: " + e))`);
  });
}

const askUntil = async (view: WebView<any, any>, expression: string, wanted: string, ms = 8000) => {
  let last = "";
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    last = await ask(view, expression).catch((e) => String(e));
    if (last === wanted) break;
  }
  return last;
};

function rectOf(fn: (hwnd: bigint, out: Int32Array) => number, hwnd: bigint): Rect {
  const r = new Int32Array(4);
  fn(hwnd, r);
  return { x: r[0]!, y: r[1]!, width: r[2]! - r[0]!, height: r[3]! - r[1]! };
}
const windowRect = (hwnd: bigint) => rectOf((h, r) => user32.GetWindowRect(h, ptr(r)), hwnd);
const clientRect = (hwnd: bigint) => rectOf((h, r) => user32.GetClientRect(h, ptr(r)), hwnd);
function clientOrigin(hwnd: bigint) {
  const p = new Int32Array(2);
  user32.ClientToScreen(hwnd, ptr(p));
  return { x: p[0]!, y: p[1]! };
}
const style = (hwnd: bigint) => BigInt(user32.GetWindowLongPtrW(hwnd, -16));
const exStyle = (hwnd: bigint) => BigInt(user32.GetWindowLongPtrW(hwnd, -20));
const hitTest = (hwnd: bigint, x: number, y: number) => Number(user32.SendMessageW(hwnd, WM_NCHITTEST, 0n, BigInt(((y & 0xffff) << 16) | (x & 0xffff))));
function minTrack(hwnd: bigint): [number, number] {
  const info = new Int32Array(10);
  user32.SendMessageW(hwnd, WM_GETMINMAXINFO, 0n, BigInt(ptr(info)));
  return [info[6]!, info[7]!];
}
function dwmDark(hwnd: bigint): boolean {
  const value = new Int32Array(1);
  dwmapi.DwmGetWindowAttribute(hwnd, 20, ptr(value), 4);
  return value[0] !== 0;
}
function workArea(hwnd: bigint): Rect {
  const info = new Int32Array(10);
  info[0] = 40;
  user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ptr(info));
  return { x: info[5]!, y: info[6]!, width: info[7]! - info[5]!, height: info[8]! - info[6]! };
}

/** The frame's webview children (`wry`'s `WRY_WEBVIEW` containers), in client coordinates. */
function webviewChildren(frame: bigint): { rect: Rect; visible: boolean }[] {
  const out: { rect: Rect; visible: boolean }[] = [];
  const name = Buffer.alloc(128);
  for (let child = user32.GetWindow(frame, 5); child !== 0n; child = user32.GetWindow(child, 2)) {
    const length = user32.GetClassNameW(child, ptr(name), 64);
    if (name.toString("utf16le", 0, length * 2) !== "WRY_WEBVIEW") continue;
    const r = windowRect(child);
    const p = new Int32Array([r.x, r.y]);
    user32.ScreenToClient(frame, ptr(p));
    // The style bit: IsWindowVisible is false for every child of a hidden frame.
    out.push({ rect: { x: p[0]!, y: p[1]!, width: r.width, height: r.height }, visible: (style(child) & 0x10000000n) !== 0n });
  }
  return out;
}

/** The top-level window under a screen point. */
function windowAt(x: number, y: number): bigint {
  const hit = user32.WindowFromPoint(BigInt.asUintN(32, BigInt(x)) | (BigInt.asUintN(32, BigInt(y)) << 32n));
  return hit === 0n ? 0n : user32.GetAncestor(hit, 2); // GA_ROOT
}
/** A pixel on the screen, as "#rrggbb". */
function screenPixel(x: number, y: number): string {
  const screen = user32.GetDC(0n);
  const c = gdi32.GetPixel(screen, x, y);
  user32.ReleaseDC(0n, screen);
  return `#${[c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const html = (n: string) =>
  new TextEncoder().encode(`<!doctype html><title>${n}</title><script>window.count = 0; window.instance = Math.random().toString(36).slice(2);</script><body>${n}</body>`);
const page = (n: string) => ({ title: n, assets: { "index.html": html(n) } });
const key = (virtualKey: number, mods: Partial<Omit<Key, "virtualKey">> = {}): Key => ({ virtualKey, control: false, shift: false, alt: false, ...mods });
const ctrl = (virtualKey: number, shift = false) => key(virtualKey, { control: true, shift });

// The pages a popup opens come from a server in a process of its own: the engine waits on
// WebView2 inside some calls (adding a script to a page), and a page loading from this
// process's own event loop would never be answered while it waits.
const server = Bun.spawn(
  [
    process.execPath,
    "-e",
    `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response("<!doctype html><title>Served " + new URL(req.url).pathname + "</title><p>served", { headers: { "content-type": "text/html" } }) }); console.log(s.port); setInterval(() => {}, 1 << 30);`,
  ],
  { stdout: "pipe", stderr: "inherit" },
);
const serverPort = await (async () => {
  const reader = server.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return Number(text.trim());
})();
const origin = `http://127.0.0.1:${serverPort}`;
const probe = fileURLToPath(new URL("./win-menu-probe.ts", import.meta.url));
const unique = `w7-tabs-${process.pid}`;

const loop = runEventLoop({ intervalMs: 5 });
// A stuck step ends the run with what it has, rather than leaving the test to kill a process that hosts webviews.
// A native timeout: it fires inside a modal loop (a popup menu's) too, where Bun's own timers do not run.
scheduleNativeTimeout(120_000, () => {
  endMenu();
  check("fixture ran to the end", false, "timed out");
  console.log(`RESULT ${JSON.stringify(results)}`);
  server.kill();
  process.exit(1);
});
const windows: Window[] = [];
const windowsOfOurs = () => windows.flatMap((w) => (w.handle ? [BigInt(w.handle)] : []));

// ---- a guard on every popup menu this process opens ----------------------------------------------
// A popup menu runs its own modal loop on this thread: nothing else here runs until it closes. A
// native timeout fires inside that loop; every quarter second it looks for a menu of this process,
// and one open longer than MENU_LIMIT_MS is ended (EndMenu) and recorded with what the OS showed,
// so a menu nobody closes fails its check instead of hanging the run.
const MENU_LIMIT_MS = 8000;
const menuHangs: Record<string, unknown>[] = [];
let menuContext: () => Record<string, unknown> = () => ({});
let menuOpenSince = 0;
let menusOpened = 0;
let guarding = true;
const guardMenus = () => {
  if (!guarding) return;
  if (openPopupMenu() === 0n) menuOpenSince = 0;
  else if (menuOpenSince === 0) {
    menuOpenSince = Date.now();
    menusOpened++;
  }
  else if (Date.now() - menuOpenSince > MENU_LIMIT_MS) {
    const hang = { menuWindowOfThisProcessOnScreen: true, openForMs: Date.now() - menuOpenSince, foregroundIsOurs: windowsOfOurs().includes(user32.GetForegroundWindow()), ...menuContext() };
    menuHangs.push(hang);
    say(`watchdog: a popup menu stayed open for ${MENU_LIMIT_MS} ms; ended it: ${JSON.stringify(hang)}`);
    endMenu();
    menuOpenSince = 0;
  }
  scheduleNativeTimeout(250, guardMenus);
};
scheduleNativeTimeout(250, guardMenus);

const make = (options: ConstructorParameters<typeof Window>[0]) => {
  const win = new Window({ title: unique, noActivate: true, ...options });
  windows.push(win);
  return win;
};

try {
  // ---- the backdrop: the strip's and the page's colours where no webview covers them -----------------
  // Frames with no tab yet have no webview: what shows is what the frame paints. Read from the
  // screen, only where the frame is the window on top (another session's window may cover it).
  for (const appearance of ["light", "dark"] as const) {
    const name = `backdrop: the strip and the page areas in their own colours (${appearance})`;
    const bare = make({ tabs: true, appearance, topmost: true, bounds: { x: 60, y: 60, width: 640, height: 420 } });
    bare.show();
    const bareHwnd = BigInt(bare.handle!);
    const bareScale = user32.GetDpiForWindow(bareHwnd) / 96;
    const o = clientOrigin(bareHwnd);
    const c = clientRect(bareHwnd);
    const stripAt = { x: o.x + 30, y: o.y + Math.round((STRIP_HEIGHT - 4) * bareScale) };
    const pageAt = { x: o.x + 30, y: o.y + c.height - 10 };
    const want = appearance === "light" ? { strip: "#e9eaee", page: "#f9f9fb" } : { strip: "#292a30", page: "#15161a" };
    let seen = { strip: "", page: "" };
    let ours = false;
    await until(() => {
      ours = windowAt(stripAt.x, stripAt.y) === bareHwnd && windowAt(pageAt.x, pageAt.y) === bareHwnd;
      seen = { strip: screenPixel(stripAt.x, stripAt.y), page: screenPixel(pageAt.x, pageAt.y) };
      return ours && seen.strip === want.strip && seen.page === want.page;
    }, 2000);
    if (!ours) skip(name, "another window covers the frame on the shared desktop");
    else check(name, seen.strip === want.strip && seen.page === want.page, { seen, want, stripAt, pageAt });
    bare.dispose();
  }

  // ---- the frame, read back from the OS ----------------------------------------------
  const win = make({ tabs: true, appearance: "dark" });
  const hwnd = BigInt(win.handle!);
  const s = style(hwnd);
  check("frame styles", (s & (WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN)) === (WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN), `0x${s.toString(16)}`);
  check("system menu", user32.GetSystemMenu(hwnd, 0) !== 0n);
  const dpi = user32.GetDpiForWindow(hwnd);
  const scale = dpi / 96;
  const outer = windowRect(hwnd);
  const client = clientRect(hwnd);
  const at = clientOrigin(hwnd);
  const edge = user32.GetSystemMetricsForDpi(32, dpi) + user32.GetSystemMetricsForDpi(92, dpi); // SM_CXSIZEFRAME + SM_CXPADDEDBORDER
  check(
    "frame metrics: a 1040 x 720 page plus the strip, the caption removed, the system border kept",
    client.width === Math.round(1040 * scale) &&
      client.height === Math.round((720 + STRIP_HEIGHT) * scale) &&
      at.x - outer.x === edge &&
      outer.x + outer.width - (at.x + client.width) === edge &&
      outer.y + outer.height - (at.y + client.height) === edge &&
      at.y - outer.y <= Math.round(scale),
    { dpi, outer, client, origin: at, edge },
  );
  const mid = { x: outer.x + outer.width / 2, y: outer.y + outer.height / 2 };
  const hits = [
    hitTest(hwnd, outer.x + 2, Math.round(mid.y)),
    hitTest(hwnd, outer.x + outer.width - 3, Math.round(mid.y)),
    hitTest(hwnd, Math.round(mid.x), outer.y + outer.height - 3),
    hitTest(hwnd, outer.x + 2, outer.y + outer.height - 3),
    hitTest(hwnd, outer.x + outer.width - 3, outer.y + outer.height - 3),
  ];
  check("resize edges: left, right, bottom and the bottom corners", JSON.stringify(hits) === JSON.stringify([10, 11, 15, 16, 17]), hits);
  const track = minTrack(hwnd);
  const wantTrack = [Math.round(560 * scale) + (outer.width - client.width), Math.round((420 + STRIP_HEIGHT) * scale) + (outer.height - client.height)];
  check("default minimum size: a 560 x 420 page plus the strip and the frame", Math.abs(track[0] - wantTrack[0]!) <= 1 && Math.abs(track[1] - wantTrack[1]!) <= 1, { track, wantTrack });
  check("dark appearance: dark title bar", dwmDark(hwnd));

  // ---- open, select, close ----------------------------------------------------------------
  const selects: TabHandle[] = [];
  const closes: TabHandle[] = [];
  const newTabs: Window[] = [];
  win.onTabSelect((t) => selects.push(t));
  win.onTabClose((t) => closes.push(t));
  win.onNewTab((o) => newTabs.push(o));
  const t1 = await WebView.openTab(win, page("one"));
  const t2 = await WebView.openTab(win, page("two"));
  const t3 = await WebView.openTab(win, page("three"));
  const strip = _debugWinTabs.strip(win)!;
  await askUntil(strip, "document.querySelectorAll('.tab').length", "3");
  const stripHeight = Math.round(STRIP_HEIGHT * scale);
  let kids = webviewChildren(hwnd);
  const visible = kids.filter((k) => k.visible).map((k) => k.rect);
  check(
    "strip and page rectangles: the strip across the top, one tab over the page area",
    kids.length === 4 &&
      visible.length === 2 &&
      visible.some((r) => r.x === 0 && r.y === 0 && r.width === client.width && r.height === stripHeight) &&
      visible.some((r) => r.x === 0 && r.y === stripHeight && r.width === client.width && r.height === client.height - stripHeight),
    { scale, kids },
  );
  check("a new tab is selected", selects.at(-1) === t3 && selects.length === 3);

  // ---- moving the window tells the strip's and every tab's webview, hidden tabs included -------------
  // (NotifyParentWindowPositionChanged: WebView2 keeps the position to itself, so the engine counts the calls.)
  const moveTold = async (target: Window, views: WebView<any, any>[]) => {
    const engines = views.map((v) => engineOf(v.raw)!);
    const before = engines.map((e) => e.movesTold());
    let moves = 0;
    const off = target.onMove(() => moves++);
    const start = target.bounds();
    target.setBounds({ ...start, x: start.x + 15, y: start.y + 10 });
    await until(() => moves > 0, 1000);
    off();
    const told = engines.map((e, i) => e.movesTold() - before[i]!);
    target.setBounds(start);
    return { moves, told };
  };
  const moved = await moveTold(win, [strip, t1.webview, t2.webview, t3.webview]);
  check("moving the window tells the strip's and every tab's webview", moved.moves > 0 && moved.told.every((n) => n === moved.moves), moved);

  // ---- a DPI change: the suggested rectangle is taken; the strip and the minimum follow the window's DPI ----
  // One monitor: the scale itself does not change, only the message and its rectangle are real.
  const beforeDpi = windowRect(hwnd);
  const suggested = new Int32Array([beforeDpi.x + 24, beforeDpi.y + 16, beforeDpi.x + 24 + beforeDpi.width + 40, beforeDpi.y + 16 + beforeDpi.height + 30]);
  user32.SendMessageW(hwnd, WM_DPICHANGED, BigInt((dpi << 16) | dpi), BigInt(ptr(suggested)));
  const afterDpi = windowRect(hwnd);
  const clientAfterDpi = clientRect(hwnd);
  const scaleAfterDpi = user32.GetDpiForWindow(hwnd) / 96;
  const stripAfterDpi = Math.round(STRIP_HEIGHT * scaleAfterDpi);
  const kidsAfterDpi = webviewChildren(hwnd).filter((k) => k.visible).map((k) => k.rect);
  const trackAfterDpi = minTrack(hwnd);
  const wantTrackAfterDpi = [Math.round(560 * scaleAfterDpi) + (afterDpi.width - clientAfterDpi.width), Math.round((420 + STRIP_HEIGHT) * scaleAfterDpi) + (afterDpi.height - clientAfterDpi.height)];
  check(
    "DPI change: the frame takes the suggested rectangle; the strip height and the default minimum follow the window's DPI",
    afterDpi.x === suggested[0] && afterDpi.y === suggested[1] && afterDpi.width === suggested[2]! - suggested[0]! && afterDpi.height === suggested[3]! - suggested[1]! &&
      kidsAfterDpi.some((r) => r.y === 0 && r.height === stripAfterDpi && r.width === clientAfterDpi.width) &&
      kidsAfterDpi.some((r) => r.y === stripAfterDpi && r.height === clientAfterDpi.height - stripAfterDpi) &&
      Math.abs(trackAfterDpi[0] - wantTrackAfterDpi[0]!) <= 1 && Math.abs(trackAfterDpi[1] - wantTrackAfterDpi[1]!) <= 1,
    { dpi, suggested: [...suggested], afterDpi, kidsAfterDpi, trackAfterDpi, wantTrackAfterDpi },
  );
  win.setBounds(beforeDpi);
  t1.select();
  await until(() => selects.at(-1) === t1);
  const shown = [await ask(t1.webview, "document.visibilityState"), await ask(t2.webview, "document.visibilityState"), await ask(t3.webview, "document.visibilityState")];
  check("select shows that tab and hides the others", JSON.stringify(shown) === JSON.stringify(["visible", "hidden", "hidden"]), shown);
  check("the window title follows the selected tab", (await ask(t1.webview, "1")) === "1" && getTitle(hwnd) === `one - ${unique}`, getTitle(hwnd));
  t2.close();
  await until(() => closes.includes(t2));
  check("close: the tab goes, onTabClose fires, its webview is destroyed", closes.at(-1) === t2 && t2.webview.raw.unsafeHandle === null && webviewChildren(hwnd).length === 3);

  // ---- `after` and every shortcut, through the handler WebView2 calls ----------------------------
  const t4 = await WebView.openTab(win, { ...page("four"), after: t1 }); // order: one, four, three
  const press = async (k: Key, on: Tab<any, any> | undefined = t1) => {
    const before = selects.length;
    const taken = _debugWinTabs.pressKey(win, k, on);
    await until(() => selects.length > before, 400);
    return taken;
  };
  const sel = () => selects.at(-1);
  const keys: Record<string, boolean> = {};
  keys["Ctrl+1"] = (await press(ctrl(0x31))) === true && sel() === t1;
  keys["Ctrl+2 (after: opens next to its tab)"] = (await press(ctrl(0x32))) === true && sel() === t4;
  keys["Ctrl+9"] = (await press(ctrl(0x39))) === true && sel() === t3;
  keys["Ctrl+Tab wraps"] = (await press(ctrl(0x09))) === true && sel() === t1;
  keys["Ctrl+PageDown"] = (await press(ctrl(0x22))) === true && sel() === t4;
  keys["Ctrl+Shift+Tab"] = (await press(ctrl(0x09, true))) === true && sel() === t1;
  keys["Ctrl+PageUp wraps"] = (await press(ctrl(0x21))) === true && sel() === t3;
  keys["Ctrl+T"] = (await press(ctrl(0x54))) === true && (await until(() => newTabs.length === 1, 1000)) && newTabs[0] === win;
  keys["a key that is no shortcut is left to the page"] = _debugWinTabs.pressKey(win, ctrl(0x58), t1) === false;
  keys["the strip takes every key"] = _debugWinTabs.pressKey(win, ctrl(0x58)) === true;
  keys["Ctrl+W closes the selected tab"] = (await press(ctrl(0x57))) === true && (await until(() => closes.includes(t3), 1000));
  t4.select();
  await until(() => sel() === t4);
  keys["Ctrl+F4 closes the selected tab"] = (await press(ctrl(0x73))) === true && (await until(() => closes.includes(t4), 1000));
  for (const [name, ok] of Object.entries(keys)) check(`shortcut ${name}`, ok);

  // ---- reordering from the strip, a tab's webview disposed directly ---------------------------------
  const r1 = await WebView.openTab(win, page("r1"));
  const r2 = await WebView.openTab(win, page("r2")); // order: one, r1, r2
  await ask(strip, `window.__sweetview_rpc("strip.move", { id: ${await stripId(strip, 2)}, index: 0 })`); // r2 first
  await Bun.sleep(100);
  await press(ctrl(0x31));
  check("strip.move reorders the tabs", sel() === r2, (sel() as Tab<any, any> | undefined)?.title);
  const closesBefore = closes.length;
  r1.select();
  await until(() => sel() === r1);
  r1.webview.dispose();
  await until(() => closes.length > closesBefore, 2000);
  await Bun.sleep(100);
  check(
    "a tab whose webview is disposed directly leaves its window, which shows another tab",
    closes.at(-1) === r1 && sel() !== r1 && webviewChildren(hwnd).filter((k) => k.visible).length === 2 && user32.IsWindow(hwnd) !== 0,
    webviewChildren(hwnd),
  );
  r2.dispose();

  // ---- concurrent openTab calls while the host is being made; a retry after a failed host ----------
  const conc = make({ tabs: true });
  const [ca, cb] = await Promise.all([WebView.openTab(conc, page("ca")), WebView.openTab(conc, page("cb"))]);
  const concStrip = _debugWinTabs.strip(conc)!;
  const concTabs = await askUntil(concStrip, "document.querySelectorAll('.tab').length", "2");
  const concKids = webviewChildren(BigInt(conc.handle!));
  check("concurrent openTab calls wait for one host: both tabs open in the window under one strip", ca.window === conc && cb.window === conc && concTabs === "2" && concKids.length === 3, { concTabs, concKids });
  conc.dispose();

  const retry = make({ tabs: true });
  const retryHwnd = BigInt(retry.handle!);
  _debugWinTabs.failNextStrip();
  const failedOpens = await Promise.allSettled([WebView.openTab(retry, page("x1")), WebView.openTab(retry, page("x2"))]);
  const strippedBack = await until(() => webviewChildren(retryHwnd).length === 0, 3000);
  const x3 = await WebView.openTab(retry, page("x3"));
  const retryStrip = _debugWinTabs.strip(retry)!;
  // One strip, one tab, and the frame callbacks of the failed host are gone: one move tells each webview once.
  const retryMoved = await moveTold(retry, [retryStrip, x3.webview]);
  check(
    "a failed host attach is forgotten: the waiting openTab fails with it, a later openTab makes the host again",
    failedOpens.every((r) => r.status === "rejected") && strippedBack && x3.window === retry && webviewChildren(retryHwnd).length === 2 && retryMoved.moves > 0 && retryMoved.told.every((n) => n === retryMoved.moves),
    { failed: failedOpens.map((r) => (r.status === "rejected" ? String(r.reason) : "opened")), retryMoved },
  );
  retry.dispose();

  // ---- the strip's close button -------------------------------------------------------------------------
  const closing = make({ tabs: true });
  let closeAsked = 0;
  closing.onClose(() => closeAsked++);
  await WebView.openTab(closing, page("closing"));
  _debugWinTabs.strip(closing)!.raw.eval(`window.__sweetview_rpc("strip.closeWindow", null)`);
  check("the strip's close button asks the window's onClose listeners", await until(() => closeAsked === 1, 2000));

  // ---- the last tab's close is offered to onClose first ------------------------------------------
  const last = make({ tabs: true });
  let asked = 0;
  const off = last.onClose(() => asked++);
  const only = await WebView.openTab(last, page("only"));
  only.close();
  await until(() => asked === 1, 2000);
  await Bun.sleep(100);
  check("last tab: an onClose listener intercepts, the tab stays", asked === 1 && only.webview.raw.unsafeHandle !== null && user32.IsWindow(BigInt(last.handle!)) !== 0);
  off();
  only.close();
  await until(() => user32.IsWindow(BigInt(last.handle!)) === 0, 2000);
  check("last tab: with no listener the window closes with it", user32.IsWindow(BigInt(last.handle!)) === 0 && only.webview.raw.unsafeHandle === null);

  // ---- Alt+F4 closes every tab, then the window -------------------------------------------------
  const altWin = make({ tabs: true });
  const a1 = await WebView.openTab(altWin, page("a1"));
  await WebView.openTab(altWin, page("a2"));
  _debugWinTabs.pressKey(altWin, key(0x73, { alt: true }), a1);
  check("shortcut Alt+F4 closes the window", await until(() => user32.IsWindow(BigInt(altWin.handle!)) === 0, 3000));

  // ---- popups become tabs --------------------------------------------------------------------
  const before = selects.length;
  const opener = t1.webview;
  await ask(opener, `(document.body.insertAdjacentHTML("beforeend", '<a id="pop" href="${origin}/popup" target="_blank" style="position:fixed;left:0;top:0;width:300px;height:200px;display:block">pop</a>'), 1)`);
  // A trusted click (DevTools input), so the page's link opens a window as a user's click does.
  for (const type of ["mousePressed", "mouseReleased"]) {
    engineOf(opener.raw)!.callDevToolsProtocolMethod("Input.dispatchMouseEvent", JSON.stringify({ type, x: 40, y: 40, button: "left", clickCount: 1 }));
  }
  await until(() => selects.length > before, 5000);
  const popup = selects.at(-1) as Tab<any, any> | undefined;
  const popupTitle = popup && popup !== t1 ? await askUntil(popup.webview, "document.title", "Served /popup") : "";
  check("a popup opens as a tab after its opener", popup !== undefined && popup !== t1 && popup.window === win && popupTitle === "Served /popup", popupTitle);
  await Bun.sleep(300);
  check("the popup tab's title follows its page", popup?.title === "Served /popup", popup?.title);
  const beforeMailto = selects.length;
  await ask(t1.webview, `(window.open("mailto:someone@example.invalid"), 1)`);
  await Bun.sleep(600);
  check("a popup to another scheme is dropped", selects.length === beforeMailto);

  // ---- the failed-load page --------------------------------------------------------------------
  const refused = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const refusedPort = refused.port;
  refused.stop(true);
  const failed = await WebView.openTab(win, { url: `http://127.0.0.1:${refusedPort}/` });
  const heading = await askUntil(failed.webview, `document.querySelector("h1")?.textContent ?? ""`, "This site did not open");
  const address = await ask(failed.webview, `document.querySelector("main p")?.textContent ?? ""`);
  check("failed load: the tab shows the page with the address", heading === "This site did not open" && address === `http://127.0.0.1:${refusedPort}/`, { heading, address });

  const home = make({ tabs: true });
  const h1 = await WebView.openTab(home, page("h1"));
  const h2 = await WebView.openTab(home, page("h2"));

  // ---- the tab menu and the system menu ----------------------------------------------------------
  // Opens the menu from the strip and has the probe (a second process) read and work it. What the
  // probe did and any watchdog report ride along, for a check that fails.
  const menu = async (id: number | null, action: string) => {
    const hangsBefore = menuHangs.length;
    const openedBefore = menusOpened;
    const helper = Bun.spawn([process.execPath, probe, String(process.pid), action], { stdout: "pipe", stderr: "pipe" });
    const probeRun = { started: helper.pid > 0, action, out: "", exitCode: null as number | null };
    menuContext = () => ({ probe: { ...probeRun, exitCode: helper.exitCode } });
    const out = new Response(helper.stdout).text().then((t) => (probeRun.out = t.trim()));
    await Bun.sleep(50);
    void strip.raw.eval(`window.__sweetview_rpc("strip.menu", ${id === null ? "null" : await stripId(strip, id)})`);
    const exited = await Promise.race([helper.exited.then(() => true), Bun.sleep(MENU_LIMIT_MS + 4000).then(() => false)]);
    if (!exited) helper.kill(); // the probe this fixture started, through its own handle
    await Promise.race([out, Bun.sleep(500)]);
    probeRun.exitCode = helper.exitCode;
    let parsed: { items?: any[] } = {};
    try {
      parsed = JSON.parse(probeRun.out.split(/\r?\n/).at(-1) || "{}");
    } catch {}
    // When the probe did not see the menu, it may still be on its way: wait for it, and for it to
    // be gone (the guard ends it), so whatever happens to it belongs to this step.
    if (parsed.items === undefined) await until(() => menusOpened > openedBefore, 3000);
    await until(() => openPopupMenu() === 0n, MENU_LIMIT_MS + 1000);
    const hangs = menuHangs.slice(hangsBefore);
    return { ...parsed, probe: probeRun, ...(hangs.length > 0 ? { hangs } : {}) } as { items?: any[]; probe: typeof probeRun; hangs?: unknown[] };
  };
  const failedMenu = (m: { probe: unknown; hangs?: unknown[] }, detail: unknown) => (m.hangs ? { hangs: m.hangs, probe: m.probe } : { detail, probe: m.probe });
  const tabMenu = await menu(0, "close");
  const labels = (tabMenu.items ?? []).map((i: { label?: string; enabled?: boolean; separator?: boolean }) => (i.separator ? "-" : `${i.label}${i.enabled ? "" : " (off)"}`));
  check(
    "tab menu items",
    !tabMenu.hangs && JSON.stringify(labels) === JSON.stringify(["New tab\tCtrl+T", "-", "Move tab to new window", "Merge all windows", "-", "Close tab\tCtrl+W", "Close other tabs"]),
    tabMenu.hangs ? failedMenu(tabMenu, labels) : labels,
  );
  const sysMenu = await menu(null, "close");
  const sysLabels = (sysMenu.items ?? []).filter((i: { separator?: boolean }) => !i.separator).map((i: { label: string; enabled: boolean }) => `${i.label.replace(/\t.*/, "")}${i.enabled ? "" : " (off)"}`);
  check(
    "system menu on the strip: Restore off and Move, Size, Minimize, Maximize, Close on while not maximised",
    !sysMenu.hangs && sysLabels.length >= 6 && sysLabels[0]!.endsWith("(off)") && sysLabels.slice(1).every((l: string) => !l.endsWith("(off)")),
    sysMenu.hangs ? failedMenu(sysMenu, sysLabels) : sysLabels,
  );
  const countBefore = closes.length;
  const picked = await menu(0, "pick:5"); // Close tab
  await until(() => closes.length > countBefore, 2000);
  check("choosing Close tab in the tab menu closes that tab", !picked.hangs && picked.items !== undefined && closes.length === countBefore + 1, failedMenu(picked, { closes: closes.length - countBefore }));

  // ---- the strip's window buttons -------------------------------------------------------------------
  const rpc = (method: string) => strip.raw.eval(`window.__sweetview_rpc("${method}", null)`);
  rpc("strip.maximize");
  await until(() => user32.IsZoomed(hwnd) !== 0, 3000);
  const zoomed = clientRect(hwnd);
  const area = workArea(hwnd);
  const zoomedAt = clientOrigin(hwnd);
  check(
    "maximised with the caption removed: the page fills the work area, the strip at its top",
    user32.IsZoomed(hwnd) !== 0 && zoomed.width === area.width && zoomed.height === area.height && zoomedAt.x === area.x && zoomedAt.y === area.y,
    { zoomed, area, zoomedAt },
  );
  check("the strip is told the window is maximised", (await askUntil(strip, "document.body.className.includes('maximized') || document.documentElement.className.includes('maximized') || !!document.querySelector('.maximized')", "true", 2000)) === "true");
  const kidsZoomed = webviewChildren(hwnd).filter((k) => k.visible).map((k) => k.rect);
  check("the strip and the page follow a resize", kidsZoomed.some((r) => r.y === 0 && r.width === zoomed.width) && kidsZoomed.some((r) => r.y === stripHeight && r.height === zoomed.height - stripHeight), kidsZoomed);
  rpc("strip.maximize");
  await until(() => user32.IsZoomed(hwnd) === 0, 3000);
  rpc("strip.minimize");
  check("strip minimise", await until(() => user32.IsIconic(hwnd) !== 0, 3000));
  win.show();
  await until(() => user32.IsIconic(hwnd) === 0, 3000);

  // ---- focus returns to the page after a strip action ------------------------------------------------
  const focusWin = make({ tabs: true, noActivate: false });
  const f1 = await WebView.openTab(focusWin, page("focus"));
  focusWin.show();
  await Bun.sleep(300);
  if (user32.GetForegroundWindow() !== BigInt(focusWin.handle!)) skip("focus returns to the page after a strip action", "the window is not the foreground window");
  else {
    const focusStrip = _debugWinTabs.strip(focusWin)!;
    await ask(focusStrip, "(document.body.focus(), 1)");
    focusStrip.raw.eval(`window.__sweetview_rpc("strip.focus", null)`);
    check("focus returns to the page after a strip action", (await askUntil(f1.webview, "document.hasFocus()", "true", 3000)) === "true");
  }
  focusWin.hide();

  // ---- file drops on the frame --------------------------------------------------------------------
  const paths = ["C:\\example\\日本語 tab.txt", "C:\\example\\second.bin"];
  const delivered: string[][] = [];
  const offDrop = win.onFileDrop((files) => delivered.push(files));
  const body = Buffer.from(paths.join("\0") + "\0\0", "utf16le");
  const dropFiles = Buffer.alloc(20 + body.length);
  dropFiles.writeUInt32LE(20, 0);
  dropFiles.writeInt32LE(1, 16);
  body.copy(dropFiles, 20);
  const drop = kernel32.GlobalAlloc(0x2, BigInt(dropFiles.length));
  new Uint8Array(toArrayBuffer(kernel32.GlobalLock(drop)!, 0, dropFiles.length)).set(dropFiles);
  kernel32.GlobalUnlock(drop);
  user32.SendMessageW(hwnd, WM_DROPFILES, drop, 0n);
  check("file drops on the frame", JSON.stringify(delivered) === JSON.stringify([paths]) && kernel32.GlobalSize(drop) === 0n, delivered);
  offDrop();

  // ---- window options on a tabbed window with tabs open ------------------------------------------
  const opt = make({ tabs: true, topmost: true, opacity: 0.75, hideFromTaskbar: true, noActivate: true, minWidth: 700, minHeight: 500 });
  await WebView.openTab(opt, page("options"));
  const optHwnd = BigInt(opt.handle!);
  const ex = exStyle(optHwnd);
  const alpha = new Uint8Array(1);
  user32.GetLayeredWindowAttributes(optHwnd, null, ptr(alpha), null);
  check("topmost", (ex & WS_EX_TOPMOST) !== 0n);
  check("opacity", (ex & WS_EX_LAYERED) !== 0n && alpha[0] === Math.round(0.75 * 255), alpha[0]);
  check("hideFromTaskbar", (ex & WS_EX_TOOLWINDOW) !== 0n);
  check("noActivate", (ex & WS_EX_NOACTIVATE) !== 0n);
  check("minimum size given as the outer frame", JSON.stringify(minTrack(optHwnd)) === "[700,500]", minTrack(optHwnd));

  // ---- appearance following the system -------------------------------------------------------------
  const sys = make({ tabs: true, appearance: "system" });
  await WebView.openTab(sys, page("system"));
  const sysStrip = _debugWinTabs.strip(sys)!;
  const sysFrame = getTabFrame(BigInt(sys.handle!))!;
  // The strip reported the system's theme when it loaded; report the other one.
  const flipped = !sysFrame.isDark();
  const reply = await ask(sysStrip, `window.__sweetview_rpc("strip.dark", ${flipped})`);
  await until(() => sysFrame.isDark() === flipped, 1000);
  check("a system frame follows the strip's report of the system theme", reply === String(flipped) && sysFrame.isDark() === flipped && dwmDark(BigInt(sys.handle!)) === flipped, { reply, flipped });
  const darkReply = await ask(strip, `window.__sweetview_rpc("strip.dark", false)`);
  await Bun.sleep(50);
  check("an explicit appearance ignores the system", darkReply === "true" && getTabFrame(hwnd)!.isDark() && dwmDark(hwnd) && (await ask(strip, "document.documentElement.dataset.theme")) === "dark", darkReply);
  // ---- tear-off and merge keep the page alive -------------------------------------------------
  // mergeAllWindows takes every tabbed window: only `home` (and the torn-off one) may be left.
  for (const w of windows) if (w !== home) w.dispose();
  const instance = await ask(h2.webview, "(window.count = 7, window.instance)");
  const torn = await h2.moveToNewWindow();
  windows.push(torn);
  const tornHwnd = BigInt(torn.handle!);
  const afterTear = [await ask(h2.webview, "window.count"), await ask(h2.webview, "window.instance")];
  const tornKids = webviewChildren(tornHwnd);
  check(
    "tear-off: the tab's webview moves to a new window with its page as it was",
    h2.window === torn && torn !== home && torn.isVisible() && afterTear[0] === "7" && afterTear[1] === instance && tornKids.length === 2 && tornKids.every((k) => k.visible),
    { afterTear, instance, tornKids },
  );
  // A file dropped on the tab's webview goes to the window the tab is in now, and only to it.
  const dropFile = join(process.env.WEBVIEW2_USER_DATA_FOLDER ?? tmpdir(), `dropped on a tab ${process.pid}.txt`);
  await Bun.write(dropFile, "drop");
  const tabDrops: Record<string, string[][]> = { home: [], torn: [] };
  const offHomeDrop = home.onFileDrop((files) => tabDrops.home!.push(files));
  const offTornDrop = torn.onFileDrop((files) => tabDrops.torn!.push(files));
  const dragFile = (view: WebView<any, any>) => {
    const engine = engineOf(view.raw)!;
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      engine.callDevToolsProtocolMethod("Input.dispatchDragEvent", JSON.stringify({ type, x: 60, y: 60, data: { items: [], files: [dropFile], dragOperationsMask: 1 } }));
    }
  };
  dragFile(h2.webview);
  await until(() => tabDrops.torn!.length > 0, 3000);
  await Bun.sleep(100);
  check("a file dropped on a torn-off tab's webview goes to its new window", JSON.stringify(tabDrops) === JSON.stringify({ home: [], torn: [[dropFile]] }), tabDrops);

  mergeAllWindows(home);
  await until(() => user32.IsWindow(tornHwnd) === 0, 2000);
  const afterMerge = [await ask(h2.webview, "(window.count += 1)"), await ask(h2.webview, "window.instance")];
  check("merge: the tab comes back with its page as it was, the emptied window closes", h2.window === home && user32.IsWindow(tornHwnd) === 0 && afterMerge[0] === "8" && afterMerge[1] === instance, afterMerge);
  // The target window's selection before the merge stays selected; the merged tab is hidden behind it.
  const merged = [await ask(h1.webview, "document.visibilityState"), await ask(h2.webview, "document.visibilityState")];
  check("merge: the window keeps its selected tab on show", JSON.stringify(merged) === JSON.stringify(["visible", "hidden"]), merged);
  // Back in `home`: a drop on the tab goes to `home` now.
  tabDrops.torn = [];
  h2.select();
  await askUntil(h2.webview, "document.visibilityState", "visible", 2000);
  dragFile(h2.webview);
  await until(() => tabDrops.home!.length > 0, 3000);
  await Bun.sleep(100);
  check("a file dropped on a merged tab's webview goes to the window it joined", JSON.stringify(tabDrops) === JSON.stringify({ home: [[dropFile]], torn: [] }), tabDrops);
  offHomeDrop();
  offTornDrop();

} catch (err) {
  check("fixture ran to the end", false, err instanceof Error ? err.stack : String(err));
} finally {
  guarding = false;
  for (const w of windows) w.dispose();
  server.kill();
  quitEventLoop();
  await loop;
}

function getTitle(hwnd: bigint): string {
  const text = Buffer.alloc(512);
  const get = dlopen("user32.dll", { GetWindowTextW: { args: [u64, FFIType.ptr, i32], returns: i32 } }).symbols;
  const length = get.GetWindowTextW(hwnd, ptr(text), 256);
  return text.toString("utf16le", 0, length * 2);
}

/** The id the strip knows the tab at `index` by. */
async function stripId(strip: WebView<any, any>, index: number): Promise<number> {
  return Number(await ask(strip, `window.__sweetview_rpc("strip.state", null).then((s) => s.tabs[${index}].id)`));
}

console.log(`RESULT ${JSON.stringify(results)}`);
process.exit(0);
