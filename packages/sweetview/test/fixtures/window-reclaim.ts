// A window that closes is destroyed and what it held is given back (decision
// D46): an application in a process of its own keeps a main window with a
// webview open under runEventLoop, and opens and closes a second window with a
// webview of its own many times (SWEETVIEW_RECLAIM_ROUNDS, default 30) by each
// path, SWEETVIEW_RECLAIM_PATHS (comma-separated, default all):
//
//   close        new Window + WebView.attach, shown; WM_CLOSE posted to it with no onClose listener
//   dispose      the same, closed by window.dispose()
//   app-dispose  createApp, shown; app.dispose()
//   tab          a tab opened in a tabbed window that keeps another tab; tab.close()
//
// Each window is shown with showOnReady and closed once its page is ready.
// After each round it waits until the closed window and its webview's
// container are gone from the OS and the process's counts have settled. It
// records, after the warm-up rounds and at the end: the process's USER and GDI
// objects and kernel handles, its private bytes (after a full garbage
// collection) and how many WebView2 processes descend from it; and it checks
// that every handle it closed fails IsWindow. It prints `RESULT <json>`. It
// injects no input: WM_CLOSE goes to a window of its own. The parent is
// src/window-reclaim.test.ts.

import { createApp, indexHtml, quitEventLoop, runEventLoop, WebView, type Tab } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { FFIType, dlopen, ptr } from "bun:ffi";
import { guiObjects, isWindow, post, user32, WM_CLOSE } from "../../../sweetview-native/test/win32-os";

const { u64, u32, i32 } = FFIType;
const kernel32 = dlopen("kernel32.dll", {
  GetCurrentProcess: { args: [], returns: u64 },
  GetCurrentProcessId: { args: [], returns: u32 },
  GetProcessHandleCount: { args: [u64, FFIType.ptr], returns: i32 },
  K32GetProcessMemoryInfo: { args: [u64, FFIType.ptr, u32], returns: i32 },
  CreateToolhelp32Snapshot: { args: [u32, u32], returns: u64 },
  Process32FirstW: { args: [u64, FFIType.ptr], returns: i32 },
  Process32NextW: { args: [u64, FFIType.ptr], returns: i32 },
  CloseHandle: { args: [u64], returns: i32 },
}).symbols;

const ROUNDS = Number(process.env.SWEETVIEW_RECLAIM_ROUNDS ?? 30);
const WARM_UP = 10;
const PATHS = (process.env.SWEETVIEW_RECLAIM_PATHS ?? "close,dispose,app-dispose,tab").split(",");
const DARK = "#1f2a33";

type Counts = { user: number; gdi: number; handles: number; privateBytes: number; webview2Processes: number };
type PathResult = {
  path: string;
  rounds: number;
  /** After WARM_UP rounds, and at the end. */
  afterWarmUp: Counts;
  atEnd: Counts;
  /** Private bytes after every round from the warm-up on, for the trend. */
  privateBytes: number[];
  /** Handles closed in the rounds that still name a window. */
  stillWindows: number;
  closedHandles: number;
  /** Round timings, ms. */
  roundMs: number[];
};

const ready = (onReady: () => void) => ({
  assets: {
    "index.html": indexHtml({ title: "reclaim", css: "", head: `<style>html,body{background:${DARK};margin:0}</style>`, body: `<p style="color:#ccd">reclaim</p>` }),
    "main.js": new Blob([`window.__sweetview_rpc("__sweetview.ready", null);`]),
  },
  showOnReady: true,
  onReady,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The `WRY_WEBVIEW` containers under `hwnd`: one per webview mounted in it. */
function webviewContainers(hwnd: bigint): bigint[] {
  const found: bigint[] = [];
  const name = new Uint16Array(64);
  for (let child = user32.FindWindowExW(hwnd, 0n, null, null); child !== 0n; child = user32.FindWindowExW(hwnd, child, null, null)) {
    const n = user32.GetClassNameW(child, ptr(name), name.length);
    if (String.fromCharCode(...name.subarray(0, n)) === "WRY_WEBVIEW") found.push(child);
  }
  return found;
}

const PROCESSENTRY32W_SIZE = 568;
/** How many msedgewebview2.exe processes descend from this one. */
function webview2Processes(): number {
  const snapshot = kernel32.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
  const entry = new Uint8Array(PROCESSENTRY32W_SIZE);
  const view = new DataView(entry.buffer);
  view.setUint32(0, PROCESSENTRY32W_SIZE, true);
  const parents = new Map<number, number>();
  const names = new Map<number, string>();
  for (let ok = kernel32.Process32FirstW(snapshot, ptr(entry)); ok; ok = kernel32.Process32NextW(snapshot, ptr(entry))) {
    const pid = view.getUint32(8, true);
    parents.set(pid, view.getUint32(32, true));
    const exe = new Uint16Array(entry.buffer, 44, 260);
    const end = exe.indexOf(0);
    names.set(pid, String.fromCharCode(...exe.subarray(0, end < 0 ? 260 : end)).toLowerCase());
  }
  kernel32.CloseHandle(snapshot);
  const self = kernel32.GetCurrentProcessId();
  let count = 0;
  for (const [pid, name] of names) {
    if (name !== "msedgewebview2.exe") continue;
    // A parent id can be reused by an unrelated process: walk at most a few levels.
    let up = parents.get(pid);
    for (let depth = 0; depth < 4 && up !== undefined && up !== 0; depth++) {
      if (up === self) {
        count++;
        break;
      }
      up = parents.get(up);
    }
  }
  return count;
}

function counts(): Counts {
  Bun.gc(true);
  const me = kernel32.GetCurrentProcess();
  const handles = new Uint32Array(1);
  kernel32.GetProcessHandleCount(me, ptr(handles));
  const memory = new BigUint64Array(10);
  new DataView(memory.buffer).setUint32(0, 80, true);
  kernel32.K32GetProcessMemoryInfo(me, ptr(memory), 80);
  return { ...guiObjects(), handles: handles[0]!, privateBytes: Number(memory[9]), webview2Processes: webview2Processes() };
}

/** Counts once they have stopped moving: read until two reads 200 ms apart agree, at most 5 s. */
async function settled(): Promise<Counts> {
  let last = counts();
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const now = counts();
    if (now.user === last.user && now.gdi === last.gdi && now.handles === last.handles && now.webview2Processes === last.webview2Processes) return now;
    last = now;
  }
  return last;
}

const bounds = { x: 560, y: 160, width: 360, height: 260 };
let tabHost: Window | undefined;

/** One round of `path`: open, wait for the page, close; returns the handles that must be gone. */
async function round(path: string): Promise<bigint[]> {
  let onReady!: () => void;
  const isReady = new Promise<void>((resolve) => (onReady = resolve));
  if (path === "close" || path === "dispose") {
    const win = new Window({ title: `reclaim ${path}`, bounds, noActivate: true, appearance: "dark" });
    const hwnd = BigInt(win.handle as bigint | number);
    await WebView.attach(win, ready(onReady));
    await isReady;
    const containers = webviewContainers(hwnd);
    if (path === "close") post(hwnd, WM_CLOSE);
    else win.dispose();
    await until(() => !isWindow(hwnd), 5_000, `${path}: the window to be destroyed`);
    return [hwnd, ...containers];
  }
  if (path === "app-dispose") {
    const app = await createApp({ title: "reclaim app", bounds, noActivate: true, appearance: "dark", ...ready(onReady) });
    const hwnd = BigInt(app.window.handle as bigint | number);
    await isReady;
    const containers = webviewContainers(hwnd);
    app.dispose();
    await until(() => !isWindow(hwnd), 5_000, "app-dispose: the window to be destroyed");
    return [hwnd, ...containers];
  }
  if (path === "tab") {
    const host = tabHost!;
    const hwnd = BigInt(host.handle as bigint | number);
    const before = new Set(webviewContainers(hwnd));
    const tab: Tab = await WebView.openTab(host, ready(onReady));
    await isReady;
    const added = webviewContainers(hwnd).filter((h) => !before.has(h));
    tab.close();
    await until(() => added.every((h) => !isWindow(h)), 5_000, "tab: its webview to be destroyed");
    return added;
  }
  throw new Error(`unknown path ${path}`);
}

const loop = runEventLoop({ intervalMs: 5 });
const results: PathResult[] = [];
let failure: string | undefined;
try {
  // The main window stays open through every round.
  let mainReady!: () => void;
  const mainIsReady = new Promise<void>((resolve) => (mainReady = resolve));
  const main = new Window({ title: "reclaim main", bounds: { x: 120, y: 160, width: 400, height: 300 }, noActivate: true, appearance: "dark" });
  await WebView.attach(main, ready(mainReady));
  await mainIsReady;
  for (const path of PATHS) {
    if (path === "tab") {
      tabHost = new Window({ title: "reclaim tabs", tabs: true, bounds: { x: 560, y: 160, width: 640, height: 420 }, noActivate: true, appearance: "dark" });
      let keeperReady!: () => void;
      const keeperIsReady = new Promise<void>((resolve) => (keeperReady = resolve));
      await WebView.openTab(tabHost, ready(keeperReady));
      await keeperIsReady;
    }
    const closed: bigint[] = [];
    const privateBytes: number[] = [];
    const roundMs: number[] = [];
    let afterWarmUp: Counts | undefined;
    for (let i = 1; i <= ROUNDS; i++) {
      const started = performance.now();
      closed.push(...(await round(path)));
      roundMs.push(Math.round(performance.now() - started));
      if (i >= WARM_UP) {
        const now = await settled();
        privateBytes.push(now.privateBytes);
        if (i === WARM_UP) afterWarmUp = now;
      }
    }
    const atEnd = await settled();
    results.push({ path, rounds: ROUNDS, afterWarmUp: afterWarmUp!, atEnd, privateBytes, stillWindows: closed.filter(isWindow).length, closedHandles: closed.length, roundMs });
    if (tabHost) {
      tabHost.dispose();
      tabHost = undefined;
    }
  }
  main.dispose();
} catch (err) {
  failure = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
} finally {
  quitEventLoop();
}
await loop;
console.log(`RESULT ${JSON.stringify({ results, failure })}`);
