// Every capability of the Webview class (checklist item W2.1), against a real
// WebView2. One scenario per process (argv[2]); prints `RESULT <json>`. Run by
// src/webview.test.ts in a child process with its own WebView2 profile.

import { Window } from "../../src/window";
import { engineOf, SizeHint, unload, Webview, WebviewError } from "../../../sweetview/src/raw-webview";
import { codeOf, finish, native, report, watchdog } from "./kit";
import * as probe from "./win32-probe";

watchdog(30_000);
const scenario = process.argv[2];
report.scenario = scenario;
const tag = `sweetview w2 ${scenario} ${process.pid}`;

/** A size in device-independent pixels, in physical pixels at this window's DPI. */
const physical = (hwnd: number, dips: number) => Math.round((dips * probe.dpi(hwnd)) / 96);
const clientIs = (hwnd: number, width: number, height: number) => {
  const size = probe.clientSize(hwnd);
  return size.width === physical(hwnd, width) && size.height === physical(hwnd, height);
};

/** The loop pumped from a Bun timer, so promises settle between pumps; resolves when `stop` is called. */
function pumped(): { done: Promise<void>; stop(): void } {
  let stop = () => {};
  const done = new Promise<void>((resolve) => {
    const pump = setInterval(() => native.pumpEvents(), 8);
    stop = () => {
      clearInterval(pump);
      resolve();
    };
  });
  return { done, stop };
}

if (scenario === "wrapper") {
  // What the Webview class adds around the engine (the engine's own window, a given window and
  // their size hints are proven in Rust, `engine_os_tests.rs`): with no size, or an explicit
  // `undefined` (JavaScript's missing argument), the size is DEFAULT_SIZE, 1024x768 with no hint,
  // shown at once; the handles are numbers; a webview in a given window names that window; and
  // run() destroys the webview when it returns, so the handles read null after.
  for (const webview of [new Webview(), new Webview(false, undefined)]) {
    const hwnd = webview.unsafeWindowHandle!;
    report[report.defaultSize === undefined ? "defaultSize" : "undefinedSize"] = clientIs(hwnd, 1024, 768) && probe.isVisible(hwnd);
    webview.destroy();
  }
  const own = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  report.handleType = typeof own.unsafeHandle;
  report.windowHandleType = typeof own.unsafeWindowHandle;
  native.scheduleTimeout(100, () => native.quitLoop());
  own.run();
  report.ownDestroyedByRun = own.unsafeHandle === null && own.unsafeWindowHandle === null;
  const win = new Window({ title: tag, bounds: { x: 80, y: 80, width: 300, height: 200 } });
  const mounted = new Webview(false, undefined, win.handle);
  report.windowHandleIsGiven = mounted.unsafeWindowHandle === Number(win.handle);
  native.scheduleTimeout(100, () => native.quitLoop());
  mounted.run();
  report.mountedDestroyedByRun = mounted.unsafeHandle === null;
  report.givenWindowKept = probe.isWindow(win.handle as number);
  win.dispose();
  finish();
}

if (scenario === "debug") {
  // new Webview(true, size): made with debug on, its page answers a binding through the class.
  // F12 and the DevTools window it opens: `engine_os_tests.rs`.
  const webview = new Webview(true, { width: 420, height: 300, hint: SizeHint.NONE });
  report.isWindow = probe.isWindow(webview.unsafeWindowHandle);
  webview.bind("answer", (a: number, b: number) => a * b);
  webview.bind("done", (value: number) => {
    report.answered = value;
    native.quitLoop();
  });
  webview.setHTML(`<!doctype html><script>window.answer(6, 7).then((v) => window.done(v));</script>`);
  webview.run();
  finish();
}

if (scenario === "content") {
  // What the class converts: values both ways, thrown errors, promises, results JSON cannot
  // carry, bindRaw and return, a second object for the same handle, destroy twice. init's
  // timing, a binding that unbinds itself, the duplicate and unknown codes and eval reaching the
  // page are proven in Rust (`engine_os_tests.rs`).
  const loop = pumped();
  const webview = new Webview(false, { width: 480, height: 320, hint: SizeHint.NONE });
  webview.title = tag;
  const handle = webview.unsafeHandle!;

  // new Webview(handle): the same webview through its handle.
  const twin = new Webview(handle);
  report.twinSameHandle = twin.unsafeHandle === handle && twin.unsafeWindowHandle === webview.unsafeWindowHandle;
  const missing = (() => {
    try {
      new Webview(0x7fff_fff0);
      return "did not throw";
    } catch (e) {
      return e instanceof WebviewError ? { fn: e.fn, code: e.code } : String(e);
    }
  })();
  report.unknownHandle = missing;

  webview.bind("echo", (...args: unknown[]) => args);
  webview.bind("throws", () => {
    throw new Error("thrown");
  });
  webview.bind("doubleLater", (n: number) => new Promise((resolve) => setTimeout(() => resolve(n * 2), 30)));
  webview.bind("rejectsLater", () => new Promise((_, reject) => setTimeout(() => reject(new Error("rejected")), 30)));
  webview.bind("bigint", () => 10n);
  webview.bind("cycle", () => {
    const c: Record<string, unknown> = {};
    c.self = c;
    return c;
  });
  webview.bind("fn", () => () => 1);
  webview.bindRaw("raw", (seq, req, arg) => webview.return(seq, 0, JSON.stringify({ req, arg })), { tag: "arg" });
  webview.bindRaw("rawFail", (seq) => webview.return(seq, 1, JSON.stringify("nope")));
  webview.bindRaw("rawEmpty", (seq) => webview.return(seq, 0, ""));

  webview.bind("callsDone", (r: Record<string, unknown>) => {
    report.calls = r;
    // eval through the second object reaches the same page.
    twin.eval("window.evaluated(window.fromPage)");
  });
  webview.bind("evaluated", (fromPage: string) => {
    report.evaluated = fromPage;
    // destroy from inside a binding, twice.
    webview.destroy();
    webview.destroy();
    report.destroyedInsideBinding = webview.unsafeHandle === null && webview.unsafeWindowHandle === null;
    report.twinAfterDestroy = codeOf(() => twin.setAsset("x", "text/plain", "x"));
    loop.stop();
  });

  webview.setAsset(
    "calls.js",
    "text/javascript",
    `window.calls = async () => {
      const r = {};
      const settle = async (p) => { try { return { ok: await p }; } catch (e) { return { err: e }; } };
      r.echo = await settle(window.echo(1, "two", { three: 3 }, [4], null, true));
      r.throws = await settle(window.throws());
      r.doubleLater = await settle(window.doubleLater(21));
      r.rejectsLater = await settle(window.rejectsLater());
      r.bigint = await settle(window.bigint());
      r.cycle = await settle(window.cycle());
      r.fn = await settle(window.fn().then((v) => typeof v));
      r.raw = await settle(window.raw("x", 2));
      r.rawFail = await settle(window.rawFail());
      r.rawEmpty = await settle(window.rawEmpty().then((v) => typeof v));
      window.callsDone(r);
    };`,
  );
  webview.setHTML(`<!doctype html><script src="${webview.assetOrigin}/calls.js"></script><script>window.fromPage = "page"; window.calls();</script>`);
  await loop.done;
  finish();
}

if (scenario === "unload") {
  // unload(): every webview this process made through Webview is destroyed.
  const own = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  const ownWindow = own.unsafeWindowHandle!;
  const win = new Window({ title: tag, bounds: { x: 60, y: 60, width: 300, height: 200 } });
  const mounted = new Webview(false, undefined, win.handle);
  unload();
  report.ownDestroyed = own.unsafeHandle === null && engineOf(own) === undefined;
  report.mountedDestroyed = mounted.unsafeHandle === null && engineOf(mounted) === undefined;
  report.ownWindowGone = !probe.isWindow(ownWindow);
  report.givenWindowKept = probe.isWindow(win.handle as number);
  // Nothing left: a second unload does nothing.
  unload();
  win.dispose();
  finish();
}

throw new Error(`unknown scenario ${scenario}`);
