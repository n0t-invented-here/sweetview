// Every capability of the Webview class (checklist item W2.1), against a real
// WebView2. One scenario per process (argv[2]); prints `RESULT <json>`. Run by
// src/webview.test.ts in a child process with its own WebView2 profile.

import { Window } from "../../src/window";
import { engineOf, SizeHint, unload, Webview, WebviewError } from "../../src/webview";
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

if (scenario === "own-window") {
  // new Webview(debug, size): a window of its own, sized and shown by `size`.
  const webview = new Webview(false, { width: 500, height: 400, hint: SizeHint.NONE });
  const hwnd = webview.unsafeWindowHandle!;
  webview.title = tag;
  report.handleType = typeof webview.unsafeHandle;
  report.windowHandleType = typeof hwnd;
  report.isWindow = probe.isWindow(hwnd);
  report.title = probe.windowText(hwnd) === tag;
  report.shownBySize = probe.isVisible(hwnd);
  report.noneSize = clientIs(hwnd, 500, 400);
  report.noneResizable = (probe.style(hwnd) & probe.WS_THICKFRAME) !== 0;
  report.darkTitleBarFollowsSystem = probe.darkTitleBar(hwnd) === probe.systemUsesDarkApps();

  webview.size = { width: 450, height: 350, hint: SizeHint.FIXED };
  report.fixedSize = clientIs(hwnd, 450, 350);
  report.fixedResizable = (probe.style(hwnd) & probe.WS_THICKFRAME) !== 0;

  webview.size = { width: 300, height: 200, hint: SizeHint.MIN };
  report.minResizable = (probe.style(hwnd) & probe.WS_THICKFRAME) !== 0;
  // The bound the OS holds the user to when they drag an edge: the outer
  // frame around a client area of the given size.
  const frame = (() => {
    const outer = probe.windowRect(hwnd);
    const client = probe.clientSize(hwnd);
    return { width: outer.width - client.width, height: outer.height - client.height };
  })();
  const min = probe.trackingBounds(hwnd);
  report.minTracking = min.minWidth === physical(hwnd, 300) + frame.width && min.minHeight === physical(hwnd, 200) + frame.height;

  webview.size = { width: 700, height: 600, hint: SizeHint.MAX };
  const max = probe.trackingBounds(hwnd);
  report.maxTracking = max.maxWidth === physical(hwnd, 700) + frame.width && max.maxHeight === physical(hwnd, 600) + frame.height;
  report.tracking = { min, max, frame, scale: probe.dpi(hwnd) / 96 };

  // Closing the window destroys the webview and ends run().
  native.scheduleTimeout(300, () => probe.postMessage(hwnd, probe.WM_CLOSE));
  webview.run();
  report.runReturnedOnClose = true;
  report.destroyedOnClose = webview.unsafeHandle === null && webview.unsafeWindowHandle === null;
  report.windowGone = !probe.isWindow(hwnd);
  finish();
}

if (scenario === "debug" || scenario === "no-debug") {
  // new Webview(true, size): debug on. The page loads and answers a binding; and, when this
  // process can take the foreground, F12 opens the developer tools, which WebView2 allows only
  // with debug on ("no-debug" is the control: the same steps with debug off open none). The
  // DevTools window belongs to WebView2's browser process and is titled after the page's URL,
  // which names this process, so another session's DevTools is never mistaken for it.
  const debug = scenario === "debug";
  const webview = new Webview(debug, { width: 420, height: 300, hint: SizeHint.NONE });
  const hwnd = webview.unsafeWindowHandle!;
  const engine = engineOf(webview)!;
  webview.title = tag;
  report.isWindow = probe.isWindow(hwnd);
  const page = `devtools-probe-${process.pid}.html`;
  webview.setAsset(page, "text/html", `<!doctype html><script>window.answer(6, 7).then((v) => window.done(v));</script>`);
  webview.bind("answer", (a: number, b: number) => a * b);
  const after = (ms: number, job: () => void) => native.scheduleTimeout(ms, job);
  const ask = (attempt: number) => {
    if (probe.takeForeground(hwnd)) {
      report.foreground = true;
      engine.moveFocus();
      report.tapped = probe.tapKey(hwnd, 0x7b); // F12
      const started = Date.now();
      const look = () => {
        const devtools = probe.topLevelWindowContaining(page);
        if (devtools !== null || Date.now() - started > 6000) {
          report.devToolsOpened = devtools !== null;
          if (devtools !== null) probe.postMessage(devtools, probe.WM_CLOSE);
          after(300, () => native.quitLoop());
          return;
        }
        after(100, look);
      };
      after(100, look);
      return;
    }
    if (attempt >= 8) {
      report.foreground = false;
      report.foregroundRefused = `the desktop did not give this process the foreground in ${attempt} attempts`;
      native.quitLoop();
      return;
    }
    after(250, () => ask(attempt + 1));
  };
  webview.bind("done", (value: number) => {
    report.answered = value;
    ask(1);
  });
  webview.navigate(`${webview.assetOrigin}/${page}`);
  webview.run();
  webview.destroy();
  finish();
}

if (scenario === "own-window-default") {
  // The default size is 1024x768 with no hint, shown at once. `undefined` is
  // JavaScript's missing argument, so it gets the same default, as it did in
  // the bindings' class.
  for (const webview of [new Webview(), new Webview(false, undefined)]) {
    const hwnd = webview.unsafeWindowHandle!;
    report[report.defaultSize === undefined ? "defaultSize" : "undefinedSize"] = clientIs(hwnd, 1024, 768) && probe.isVisible(hwnd);
    webview.destroy();
    // destroy() closes the window at once, without waiting for a loop to run.
    report[report.closedAtOnce === undefined ? "closedAtOnce" : "closedAtOnce2"] = !probe.isWindow(hwnd);
  }
  finish();
}

if (scenario === "given-window") {
  // new Webview(debug, size, window): mounted in an application's window,
  // which the size restyles and resizes as the C++ library did, and never shows.
  const win = new Window({ title: "before", bounds: { x: 80, y: 80, width: 300, height: 200 } });
  const hwnd = Number(win.handle);
  const webview = new Webview(false, { width: 420, height: 260, hint: SizeHint.NONE }, win.handle);
  report.windowHandleIsGiven = webview.unsafeWindowHandle === hwnd;
  report.notShownBySize = !probe.isVisible(hwnd);
  report.noneSize = clientIs(hwnd, 420, 260);
  report.noneStyle = (probe.style(hwnd) & (probe.WS_THICKFRAME | probe.WS_MAXIMIZEBOX)) === (probe.WS_THICKFRAME | probe.WS_MAXIMIZEBOX);
  webview.title = tag;
  report.title = probe.windowText(hwnd) === tag;

  webview.size = { width: 400, height: 250, hint: SizeHint.FIXED };
  report.fixedSize = clientIs(hwnd, 400, 250);
  report.fixedStyle = (probe.style(hwnd) & (probe.WS_THICKFRAME | probe.WS_MAXIMIZEBOX)) === 0;

  webview.size = { width: 100, height: 100, hint: SizeHint.MIN };
  report.minStyleOnly = clientIs(hwnd, 400, 250) && (probe.style(hwnd) & probe.WS_THICKFRAME) !== 0;
  webview.size = { width: 900, height: 900, hint: SizeHint.MAX };
  report.maxStyleOnly = clientIs(hwnd, 400, 250);
  webview.size = { width: 400, height: 250, hint: SizeHint.FIXED };

  // The page fills the window and follows a later size.
  const widths: number[] = [];
  webview.bind("width", (w: number) => {
    widths.push(w);
    if (Math.abs(w - 400) <= 1 && !report.followed400) {
      report.followed400 = true;
      webview.size = { width: 500, height: 300, hint: SizeHint.NONE };
    } else if (Math.abs(w - 500) <= 1 && report.followed400) {
      report.followed500 = true;
      native.quitLoop();
    }
  });
  webview.setHTML(`<!doctype html><body><script>
    window.width(Math.round(innerWidth));
    let last = innerWidth;
    addEventListener("resize", () => { if (innerWidth !== last) { last = innerWidth; window.width(Math.round(innerWidth)); } });
  </script></body>`);
  win.show();
  webview.run();
  report.pageWidths = widths;
  report.destroyedByRun = webview.unsafeHandle === null;
  report.givenWindowKept = probe.isWindow(hwnd);
  win.dispose();
  finish();
}

if (scenario === "content") {
  const loop = pumped();
  const webview = new Webview(false, { width: 480, height: 320, hint: SizeHint.NONE });
  webview.title = tag;
  const handle = webview.unsafeHandle!;
  const pages: Record<string, unknown>[] = [];

  // init: runs before the page's own scripts, in every later document.
  webview.init(`window.__init = { seenAt: document.readyState, scripts: document.scripts.length, href: location.href };`);
  const pageScript = `<script>window.page({ init: window.__init || null, href: location.href, fromTwin: window.fromTwin || null });</script>`;
  webview.setAsset("a.html", "text/html; charset=utf-8", `<!doctype html><title>A</title>${pageScript}`);
  webview.setAsset("b.html", "text/html; charset=utf-8", `<!doctype html><title>B</title>${pageScript}`);

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

  webview.bind("page", (info: Record<string, unknown>) => {
    pages.push(info);
    if (pages.length === 1) webview.navigate(`${webview.assetOrigin}/b.html`);
    else if (pages.length === 2) webview.setHTML(`<!doctype html><title>C</title>${pageScript}<script src="${webview.assetOrigin}/calls.js"></script><script>window.calls();</script>`);
  });

  // bind: values, thrown errors, promises, results JSON cannot carry.
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
  // bindRaw and return.
  webview.bindRaw("raw", (seq, req, arg) => webview.return(seq, 0, JSON.stringify({ req, arg })), { tag: "arg" });
  webview.bindRaw("rawFail", (seq) => webview.return(seq, 1, JSON.stringify("nope")));
  webview.bindRaw("rawEmpty", (seq) => webview.return(seq, 0, ""));
  // A binding that unbinds itself from inside its own call.
  let goneCalls = 0;
  webview.bind("gone", () => {
    goneCalls++;
    webview.unbind("gone");
    return "bye";
  });
  report.duplicateBind = codeOf(() => webview.bind("echo", () => 0));
  report.unbindUnknown = codeOf(() => webview.unbind("never"));

  webview.bind("callsDone", (r: Record<string, unknown>) => {
    report.calls = r;
    report.goneCalls = goneCalls;
    report.unbindAgain = codeOf(() => webview.unbind("gone"));
    // eval: runs in the current document.
    twin.eval("window.fromTwin = 'twin'");
    webview.eval("window.evaluated(document.title, 6 * 7, window.fromTwin)");
  });
  webview.bind("evaluated", (title: string, n: number, fromTwin: string) => {
    report.evaluated = { title, n, fromTwin };
    // destroy from inside a binding, twice.
    webview.destroy();
    webview.destroy();
    report.destroyedInsideBinding = webview.unsafeHandle === null && webview.unsafeWindowHandle === null;
    report.twinAfterDestroy = codeOf(() => twin.setAsset("x", "text/plain", "x"));
    loop.stop();
  });

  // The third page drives the calls.
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
      r.gone = await settle(window.gone());
      await new Promise((resolve) => setTimeout(resolve, 100));
      r.goneAfterUnbind = typeof window.gone;
      window.callsDone(r);
    };`,
  );
  webview.navigate(`${webview.assetOrigin}/a.html`);
  await loop.done;
  report.pages = pages;
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
