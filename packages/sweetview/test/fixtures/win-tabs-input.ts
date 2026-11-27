// Live fixture for src/tabs/win-tabs.test.ts: the tab strip's gestures that
// need a held mouse button (strip.drag, strip.resize, strip.detach) and real
// key presses, driven with real input (SendInput) in a process of its own.
//
// A gesture hands this process's UI thread to the OS's own move or size loop
// until the button comes up, so the cursor moves and the release are made
// from native timeouts, which fire inside that loop (the pattern of
// window-native.test.ts, "startDrag hands the window to the OS ...").
//
// The mouse and keyboard are the whole machine's, and other sessions use
// them. So the button is pressed only when no button is down and the
// fixture's own window is under the cursor; a key is pressed only while the
// fixture's own window is the foreground window; the button and the keys are
// always let go (a watchdog and `finally`). When the desktop is not the
// fixture's, a check is retried and then recorded as skipped with the reason.
// Prints `RESULT <json>` as win-tabs.ts does.

import { FFIType, dlopen, ptr } from "bun:ffi";
import { writeSync } from "node:fs";
import { WebView, type Tab } from "../../src/index";
import { Screen, Window, quitEventLoop, runEventLoop } from "@n1h/sweetview-native";
import { scheduleNativeTimeout } from "@n1h/sweetview-native/internal";
import { STRIP_HEIGHT, TABS_LEFT, dropIndex, tabWidth } from "@n1h/sweetview-native/win32/strip-shared";
import { buttonsDown, inMoveSize, injectCursorMove, injectLeftButton, moveLoopControl, windowAt as windowAtXY } from "../../../sweetview-native/test/win32-os";
import { _debugWinTabs } from "../../src/tabs/win-tabs";

const { u64, u32, i32 } = FFIType;
const user32 = dlopen("user32.dll", {
  SendInput: { args: [u32, FFIType.ptr, i32], returns: u32 },
  GetCursorPos: { args: [FFIType.ptr], returns: i32 },
  GetAsyncKeyState: { args: [i32], returns: FFIType.i16 },
  GetForegroundWindow: { args: [], returns: u64 },
  GetWindowRect: { args: [u64, FFIType.ptr], returns: i32 },
  ClientToScreen: { args: [u64, FFIType.ptr], returns: i32 },
  GetDpiForWindow: { args: [u64], returns: u32 },
  IsWindow: { args: [u64], returns: i32 },
  IsZoomed: { args: [u64], returns: i32 },
  PostMessageW: { args: [u64, u32, u64, FFIType.i64], returns: i32 },
}).symbols;

type Point = { x: number; y: number };
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

// ---- the OS, read and driven ------------------------------------------------------------------

const windowRect = (hwnd: bigint): Rect => {
  const r = new Int32Array(4);
  user32.GetWindowRect(hwnd, ptr(r));
  return { x: r[0]!, y: r[1]!, width: r[2]! - r[0]!, height: r[3]! - r[1]! };
};
const clientOrigin = (hwnd: bigint): Point => {
  const p = new Int32Array(2);
  user32.ClientToScreen(hwnd, ptr(p));
  return { x: p[0]!, y: p[1]! };
};
const scaleOf = (hwnd: bigint) => user32.GetDpiForWindow(hwnd) / 96;
/** A point of the frame's client area, given in device-independent pixels, on the screen. */
const onScreen = (hwnd: bigint, x: number, y: number): Point => {
  const o = clientOrigin(hwnd);
  const s = scaleOf(hwnd);
  return { x: o.x + Math.round(x * s), y: o.y + Math.round(y * s) };
};
const cursor = (): Point => {
  const p = new Int32Array(2);
  user32.GetCursorPos(ptr(p));
  return { x: p[0]!, y: p[1]! };
};
const windowAt = (p: Point) => windowAtXY(p.x, p.y);

let buttonHeld = false;
function leftButton(down: boolean): void {
  injectLeftButton(down);
  buttonHeld = down;
}
const moveCursorAsInput = (p: Point) => injectCursorMove(p.x, p.y, Screen.bounds());
const keysHeld = new Set<number>();
function key(virtualKey: number, down: boolean): void {
  const input = new Uint8Array(40); // INPUT, x64: type, KEYBDINPUT at 8 (wVk, wScan, dwFlags at 12, time, dwExtraInfo)
  const view = new DataView(input.buffer);
  view.setUint32(0, 1, true); // INPUT_KEYBOARD
  view.setUint16(8, virtualKey, true);
  view.setUint32(12, down ? 0 : 0x2, true); // KEYEVENTF_KEYUP
  user32.SendInput(1, ptr(input), 40);
  if (down) keysHeld.add(virtualKey);
  else keysHeld.delete(virtualKey);
}
function letGo(): void {
  if (buttonHeld) leftButton(false);
  for (const vk of [...keysHeld].reverse()) key(vk, false);
}

type Gesture = {
  /** Where the button goes down, and the window that must be under it. */
  press: Point;
  owner: bigint;
  /** Cursor moves made after the press and before the OS loop starts (the page sees them). */
  before?: Point[];
  /** Cursor moves made from inside the OS loop, once it has started. */
  inLoop: Point[];
  /** Read from inside the loop, after the last move and before the release. */
  during?: () => unknown;
};
type GestureRun = { ran: false; why: string } | { ran: true; looped: boolean; during: unknown; watchdog?: unknown };

/** How long a gesture may hold the button before its watchdog ends it. */
const GESTURE_LIMIT_MS = 15_000;

/**
 * Presses the left button at `press` over the fixture's own window, makes the
 * `before` moves, waits for the OS loop the press leads to, makes the
 * `inLoop` moves from inside it and releases the button there. The button is
 * always released: a watchdog that fires inside the loop releases it, ends
 * the loop (WM_CANCELMODE to the window) and reports what the OS said then.
 * Retried a few times while the desktop is not the fixture's.
 */
async function gesture(g: Gesture): Promise<GestureRun> {
  let why = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await Bun.sleep(700);
    moveCursorAsInput(g.press);
    await Bun.sleep(60);
    if (buttonsDown()) {
      why = "a mouse button was already down on the shared desktop";
      continue;
    }
    if (windowAt(g.press) !== g.owner) {
      why = "another window was under the cursor on the shared desktop";
      continue;
    }
    let looped = false;
    let during: unknown;
    let watchdog: unknown;
    let done = false;
    const hung = () => {
      if (done && !buttonHeld && !inMoveSize()) return;
      watchdog = { inMoveSize: inMoveSize(), leftDown: user32.GetAsyncKeyState(0x01) < 0, cursor: cursor(), foregroundIsOurs: user32.GetForegroundWindow() === g.owner, looped };
      say(`watchdog: a gesture held the button for ${GESTURE_LIMIT_MS} ms: ${JSON.stringify(watchdog)}`);
      done = true;
      letGo();
      user32.PostMessageW(g.owner, 0x001f, 0n, 0n); // WM_CANCELMODE ends a move or size loop
    };
    const stopWatchdog = scheduleNativeTimeout(GESTURE_LIMIT_MS, hung);
    try {
      // The press itself may start the OS loop at once (the strip asks for a drag on mousedown),
      // and from then on this async function does not run until the loop ends: everything that
      // must happen inside the loop runs from native timeouts, armed before the press.
      const started = Date.now();
      const poll = () => {
        if (done) return;
        if (!inMoveSize()) {
          if (Date.now() - started > 10_000) {
            done = true;
            leftButton(false);
          } else scheduleNativeTimeout(20, poll);
          return;
        }
        looped = true;
        const step = (i: number) => {
          if (done) return;
          if (i < g.inLoop.length) {
            moveCursorAsInput(g.inLoop[i]!);
            scheduleNativeTimeout(120, () => step(i + 1));
            return;
          }
          during = g.during?.();
          done = true;
          leftButton(false);
        };
        scheduleNativeTimeout(60, () => step(0));
      };
      scheduleNativeTimeout(20, poll);
      leftButton(true);
      await until(() => done || user32.GetAsyncKeyState(0x01) < 0, 1000);
      await Bun.sleep(80);
      // Moves the page sees before any loop starts (a tab dragged far enough to detach).
      for (const p of g.before ?? []) {
        if (done || inMoveSize()) break;
        moveCursorAsInput(p);
        await Bun.sleep(80);
      }
      await until(() => done, GESTURE_LIMIT_MS);
      if (!(await until(() => !inMoveSize(), 2000))) user32.PostMessageW(g.owner, 0x001f, 0n, 0n);
      await Bun.sleep(300);
      return { ran: true, looped, during, ...(watchdog === undefined ? {} : { watchdog }) };
    } finally {
      done = true;
      stopWatchdog();
      letGo();
    }
  }
  return { ran: false, why };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number, b: number, by = 1) => Math.abs(a - b) <= by;

/** The move-loop control's verdict, read once before the first gesture. */
let noMoveLoop: string | undefined;
/** Records a gesture that did not run to its end: skipped (the desktop was not the fixture's, or the session runs no move loop), or failed with what its watchdog read. */
function misfired(name: string, run: GestureRun | undefined): void {
  if (run === undefined) return;
  if (!run.ran) skip(name, run.why);
  else check(name, false, { watchdog: run.watchdog, looped: run.looped });
}
/** Runs a gesture unless the move-loop control found that this session's OS runs no move loop. */
async function gestureOrSkip(name: string, g: Gesture): Promise<GestureRun | undefined> {
  if (noMoveLoop !== undefined) {
    skip(name, noMoveLoop);
    return undefined;
  }
  return gesture(g);
}

// ---- the run -----------------------------------------------------------------------------------

const unique = `w7-tabs-input-${process.pid}`;
const html = (n: string) =>
  new TextEncoder().encode(`<!doctype html><title>${n}</title><script>window.instance = Math.random().toString(36).slice(2);</script><body style="margin:0;height:100vh">${n}</body>`);
const page = (n: string) => ({ title: n, assets: { "index.html": html(n) } });

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
const stripTitles = (win: Window) => ask(_debugWinTabs.strip(win)!, `window.__sweetview_rpc("strip.state", null).then((s) => s.tabs.map((t) => t.title).join("|"))`);
const waitStrip = async (win: Window, titles: string) => {
  for (let i = 0; i < 40 && (await stripTitles(win).catch(() => "")) !== titles; i++) await Bun.sleep(100);
  return stripTitles(win);
};

const loop = runEventLoop({ intervalMs: 5 });
// A stuck step ends the run with what it has. A native timeout: it fires inside a modal loop too,
// where Bun's own timers do not run.
scheduleNativeTimeout(170_000, () => {
  letGo();
  check("fixture ran to the end", false, "timed out");
  console.log(`RESULT ${JSON.stringify(results)}`);
  process.exit(1);
});
process.on("exit", letGo);

const windows: Window[] = [];
const make = (options: ConstructorParameters<typeof Window>[0]) => {
  const win = new Window({ title: unique, noActivate: true, topmost: true, ...options });
  windows.push(win);
  return win;
};
const handle = (win: Window) => BigInt(win.handle!);
const DOUBLE_CLICK_GAP = 700; // two presses at one place closer than this are a double click

try {
  // ---- the move-loop control: does this session's OS run a move loop for injected input at all? ----
  const control = await moveLoopControl(Screen.bounds());
  say(`move-loop control: ${JSON.stringify(control)}`);
  if (!control.ok) noMoveLoop = `the session's OS started no move loop for the control window either (${control.why}): ${JSON.stringify(control.readings)}`;

  // ---- strip.drag: the window follows the cursor, the held point under it -----------------------------
  const w1 = make({ tabs: true, bounds: { x: 160, y: 120, width: 900, height: 600 } });
  const p1 = await WebView.openTab(w1, page("p1"));
  const p2 = await WebView.openTab(w1, page("p2"));
  w1.show();
  await waitStrip(w1, "p1|p2");
  await Bun.sleep(300);
  const h1 = handle(w1);
  {
    const name = "strip.drag: the window follows the cursor, the held point stays under it";
    const start = windowRect(h1);
    // Empty strip: right of the tabs and the + button, left of the window buttons.
    const press = onScreen(h1, 650, 20);
    const to = { x: press.x + 60, y: press.y + 45 };
    const run = await gestureOrSkip(name, { press, owner: h1, inLoop: [to], during: () => windowRect(h1) });
    if (run === undefined || !run.ran || run.watchdog !== undefined) misfired(name, run);
    else {
      const after = windowRect(h1);
      const held = onScreen(h1, 650, 20);
      check(name, run.looped && same(after, { ...start, x: start.x + 60, y: start.y + 45 }) && same(run.during, after) && same(held, to), { start, after, during: run.during, held, to, looped: run.looped });
    }
  }
  await Bun.sleep(DOUBLE_CLICK_GAP);

  // ---- strip.resize: top, top-left, top-right ----------------------------------------------------
  for (const [edge, at, by] of [
    ["top", (w: number) => ({ x: w / 2, y: 2 }), { x: 0, y: -30 }],
    ["top-left", () => ({ x: 2, y: 2 }), { x: -25, y: -20 }],
    ["top-right", (w: number) => ({ x: w - 2, y: 2 }), { x: 25, y: -20 }],
  ] as const) {
    const name = `strip.resize ${edge}`;
    const start = windowRect(h1);
    const widthDip = (start.width - 2 * (clientOrigin(h1).x - start.x)) / scaleOf(h1);
    const dip = at(widthDip);
    const press = onScreen(h1, dip.x, dip.y);
    const run = await gestureOrSkip(name, { press, owner: h1, inLoop: [{ x: press.x + by.x, y: press.y + by.y }] });
    if (run === undefined || !run.ran || run.watchdog !== undefined) misfired(name, run);
    else {
      const after = windowRect(h1);
      const want = {
        x: start.x + (edge === "top-left" ? by.x : 0),
        y: start.y + by.y,
        width: start.width + (edge === "top-left" ? -by.x : edge === "top-right" ? by.x : 0),
        height: start.height - by.y,
      };
      check(name, run.looped && same(after, want), { start, after, want, looped: run.looped });
    }
    await Bun.sleep(DOUBLE_CLICK_GAP);
  }
  w1.setBounds({ x: 160, y: 120, width: 900, height: 600 });
  await Bun.sleep(200);

  // ---- strip.drag from a maximised window: it restores, then follows -------------------------------
  {
    const name = "strip.drag from a maximised window: it restores first and follows the cursor";
    const restored = windowRect(h1);
    w1.toggleMaximize();
    await until(() => user32.IsZoomed(h1) !== 0, 3000);
    await Bun.sleep(300);
    const zoomedWidth = (windowRect(h1).width - 2 * (clientOrigin(h1).x - windowRect(h1).x)) / scaleOf(h1);
    const press = onScreen(h1, zoomedWidth - 320, 20);
    const to = { x: press.x + 40, y: press.y + 140 };
    // A first step just past the drag threshold: the OS restores the window there (a mouse
    // moves a few pixels at a time; one long jump would be spent on the restore).
    const run = await gestureOrSkip(name, { press, owner: h1, inLoop: [{ x: press.x, y: press.y + 6 }, { x: press.x + 20, y: press.y + 60 }, to] });
    if (run === undefined || !run.ran || run.watchdog !== undefined) misfired(name, run);
    else {
      const after = windowRect(h1);
      const strip = { ...clientOrigin(h1), width: after.width, height: Math.round(STRIP_HEIGHT * scaleOf(h1)) };
      const underCursor = to.x >= strip.x && to.x < strip.x + strip.width && to.y >= strip.y && to.y < strip.y + strip.height;
      check(name, run.looped && user32.IsZoomed(h1) === 0 && after.width === restored.width && after.height === restored.height && underCursor, { restored, after, to, strip, looped: run.looped });
    }
    if (user32.IsZoomed(h1) !== 0) w1.toggleMaximize();
    w1.setBounds({ x: 160, y: 120, width: 900, height: 600 });
    await Bun.sleep(DOUBLE_CLICK_GAP);
  }

  // ---- strip.detach (a): a tab dragged out of a window with several tabs ----------------------------
  {
    const name = "strip.detach: a tab dragged out of a window with several tabs becomes a new window at the cursor, same size, keeping its page";
    const instance = await ask(p2.webview, "window.instance");
    const source = windowRect(h1);
    const width = tabWidth(900, 2);
    const held = { x: TABS_LEFT + width + Math.round(width / 2), y: 20 }; // the middle of the second tab
    const press = onScreen(h1, held.x, held.y);
    const s = scaleOf(h1);
    // Down out of the strip: the strip detaches the tab past STRIP_HEIGHT + 28.
    const out = { x: press.x, y: press.y + Math.round(90 * s) };
    const to = { x: out.x + 50, y: out.y + 30 };
    const run = await gestureOrSkip(name, { press, owner: h1, before: [{ x: press.x, y: press.y + Math.round(30 * s) }, out], inLoop: [to] });
    if (run === undefined || !run.ran || run.watchdog !== undefined) misfired(name, run);
    else {
      await until(() => p2.window !== w1, 2000);
      const torn = p2.window;
      const th = handle(torn);
      if (torn !== w1) windows.push(torn);
      const tornRect = windowRect(th);
      // In the new window the tab is the first: the point under the cursor is where it was grabbed in the tab.
      const heldNow = onScreen(th, TABS_LEFT + (held.x - TABS_LEFT - width), held.y);
      const page = await ask(p2.webview, "window.instance").catch((e) => String(e));
      check(
        name,
        run.looped && torn !== w1 && p1.window === w1 && tornRect.width === source.width && tornRect.height === source.height && near(heldNow.x, to.x) && near(heldNow.y, to.y) && page === instance,
        { source, tornRect, heldNow, to, page, instance, looped: run.looped },
      );
    }
    await Bun.sleep(DOUBLE_CLICK_GAP);
  }

  // ---- strip.detach (b): the only tab of a window drags the whole window ----------------------------
  const w2 = make({ tabs: true, bounds: { x: 1150, y: 520, width: 700, height: 460 } });
  const q1 = await WebView.openTab(w2, page("q1"));
  w2.show();
  await waitStrip(w2, "q1");
  await Bun.sleep(300);
  const h2 = handle(w2);
  {
    const name = "strip.detach: the only tab of a window drags the whole window";
    const start = windowRect(h2);
    const held = { x: TABS_LEFT + 60, y: 20 };
    const press = onScreen(h2, held.x, held.y);
    const nudge = { x: press.x + 12, y: press.y };
    const to = { x: press.x + 70, y: press.y + 50 };
    const run = await gestureOrSkip(name, { press, owner: h2, before: [nudge], inLoop: [to] });
    if (run === undefined || !run.ran || run.watchdog !== undefined) misfired(name, run);
    else {
      const after = windowRect(h2);
      const heldNow = onScreen(h2, held.x, held.y);
      check(
        name,
        run.looped && q1.window === w2 && user32.IsWindow(h2) !== 0 && after.width === start.width && after.height === start.height && near(heldNow.x, to.x) && near(heldNow.y, to.y),
        { start, after, heldNow, to, looped: run.looped },
      );
    }
    await Bun.sleep(DOUBLE_CLICK_GAP);
  }

  // ---- strip.detach (c): a tab dropped on another window's strip joins it at the drop index -------------
  {
    const name = "strip.detach: a tab dropped on another window's strip joins it at the drop index";
    w1.setBounds({ x: 160, y: 120, width: 900, height: 600 });
    await waitStrip(w1, "p1");
    await WebView.openTab(w1, page("p3")); // w1: p1, p3
    await waitStrip(w1, "p1|p3");
    const w3 = make({ tabs: true, bounds: { x: 1150, y: 120, width: 700, height: 360 } });
    const r1 = await WebView.openTab(w3, page("r1"));
    w3.show();
    await waitStrip(w3, "r1");
    await Bun.sleep(300);
    const h3 = handle(w3);
    const instance = await ask(r1.webview, "window.instance");
    const press = onScreen(h3, TABS_LEFT + 60, 20);
    // Over w1's strip, on the right half of its first tab: the tab goes after it.
    const width = tabWidth(900, 2);
    const dropDip = TABS_LEFT + Math.round(width * 0.75);
    const to = onScreen(h1, dropDip, 20);
    const wantIndex = dropIndex(900, 2, dropDip);
    const run = await gestureOrSkip(name, { press, owner: h3, before: [{ x: press.x + 12, y: press.y }], inLoop: [{ x: press.x - 200, y: press.y + 40 }, to] });
    if (run === undefined || !run.ran || run.watchdog !== undefined) misfired(name, run);
    else {
      await until(() => r1.window === w1, 2000);
      const titles = await waitStrip(w1, ["p1", "p3"].toSpliced(wantIndex, 0, "r1").join("|"));
      const page = await ask(r1.webview, "window.instance").catch((e) => String(e));
      await until(() => user32.IsWindow(h3) === 0, 2000);
      check(
        name,
        run.looped && r1.window === w1 && titles === ["p1", "p3"].toSpliced(wantIndex, 0, "r1").join("|") && user32.IsWindow(h3) === 0 && page === instance,
        { titles, wantIndex, page, instance, looped: run.looped },
      );
    }
    await Bun.sleep(DOUBLE_CLICK_GAP);
  }

  // ---- real keys: Ctrl+T and Ctrl+W while a tab's page has the keyboard focus -------------------------
  {
    const name = "real keys: Ctrl+T opens a tab and Ctrl+W closes it while the page has the keyboard focus";
    const kw = make({ tabs: true, noActivate: false, bounds: { x: 300, y: 200, width: 800, height: 500 } });
    const kh = handle(kw);
    const opened: Tab<any, any>[] = [];
    const closed: unknown[] = [];
    kw.onNewTab(() => void WebView.openTab(kw, page(`k${opened.length + 2}`)).then((t) => opened.push(t)));
    kw.onTabClose((t) => closed.push(t));
    const k1 = await WebView.openTab(kw, page("k1"));
    kw.show();
    await waitStrip(kw, "k1");
    await Bun.sleep(300);
    // A process started in the background is not given the foreground; a click of the user's
    // (here, injected) on the fixture's own page gives it, as it would to any application.
    let why = "";
    for (let attempt = 0; attempt < 4 && user32.GetForegroundWindow() !== kh; attempt++) {
      const at = onScreen(kh, 400, 250);
      moveCursorAsInput(at);
      await Bun.sleep(60);
      if (buttonsDown() || windowAt(at) !== kh) {
        why = "another window was under the cursor on the shared desktop";
        await Bun.sleep(700);
        continue;
      }
      leftButton(true);
      await Bun.sleep(40);
      leftButton(false);
      await until(() => user32.GetForegroundWindow() === kh, 1500);
      why = "the window did not become the foreground window";
    }
    const focused = user32.GetForegroundWindow() === kh && (await ask(k1.webview, "document.hasFocus()").catch(() => "")) === "true";
    if (!focused) skip(name, why || "the page did not have the keyboard focus");
    else {
      // The page that is shown has the keyboard focus before each chord (focus moves to a new tab asynchronously).
      const chord = async (vk: number, on: WebView<any, any>) => {
        await until(() => user32.GetForegroundWindow() === kh, 1000);
        for (let i = 0; i < 20 && (await ask(on, "document.hasFocus()").catch(() => "")) !== "true"; i++) await Bun.sleep(100);
        if (user32.GetForegroundWindow() !== kh) return false;
        try {
          key(0x11, true); // VK_CONTROL
          key(vk, true);
          key(vk, false);
        } finally {
          letGo();
        }
        return true;
      };
      const ctrlT = (await chord(0x54, k1.webview)) && (await until(() => opened.length === 1, 3000));
      const titlesAfterT = await waitStrip(kw, "k1|k2");
      await Bun.sleep(300);
      const ctrlW = ctrlT && (await chord(0x57, opened[0]!.webview)) && (await until(() => closed.length === 1, 3000));
      const titlesAfterW = await waitStrip(kw, "k1");
      if (user32.GetForegroundWindow() !== kh && !(ctrlT && ctrlW)) skip(name, "the window lost the foreground on the shared desktop");
      else check(name, ctrlT && ctrlW && opened[0] === closed[0] && titlesAfterT === "k1|k2" && titlesAfterW === "k1", { ctrlT, ctrlW, titlesAfterT, titlesAfterW, foregroundIsOurs: user32.GetForegroundWindow() === kh });
    }
    kw.hide();
  }
} catch (err) {
  check("fixture ran to the end", false, err instanceof Error ? err.stack : String(err));
} finally {
  letGo();
  for (const w of windows) w.dispose();
  quitEventLoop();
  await loop;
}

console.log(`RESULT ${JSON.stringify(results)}`);
process.exit(0);
