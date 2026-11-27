// W1.3 and W1.4 for the webview's callback kinds: a binding, a request
// handler, a file drop handler, an accelerator-key handler, a new-window
// handler and a navigation-failed handler. An exception thrown from each is
// caught at the boundary and logged, and the loop goes on; each may remove
// itself, or destroy its webview, from inside its own call. One scenario per
// process (argv[2]); prints `RESULT <json>`; the test reads stderr for the
// log lines.
//
// The accelerator-key, new-window and navigation-failed handlers are the
// engine's (the tabs library wraps them); the others go through the Webview
// class, whose wrappers catch an application's exception first, and also
// straight to the engine, to reach the binding's own backstop.

import { join } from "node:path";
import { engineOf, SizeHint, Webview } from "../../src/webview";
import { codeOf, finish, native, report, watchdog } from "./kit";
import * as probe from "./win32-probe";

watchdog(30_000);
const scenario = process.argv[2];
report.scenario = scenario;
const webview = new Webview(false, { width: 360, height: 240, hint: SizeHint.NONE });
webview.title = `sweetview w1 ${scenario} ${process.pid}`;
const engine = engineOf(webview)!;
const origin = webview.assetOrigin;
const after = (ms: number, job: () => void) => native.scheduleTimeout(ms, job);
const fileDrop = async (name: string) => {
  const file = join(process.env.WEBVIEW2_USER_DATA_FOLDER!, name);
  await Bun.write(file, name);
  return () => {
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      engine.callDevToolsProtocolMethod("Input.dispatchDragEvent", JSON.stringify({ type, x: 40, y: 40, data: { items: [], files: [file], dragOperationsMask: 1 } }));
    }
  };
};
const destroyedCodes = () => ({
  setRequestHandler: codeOf(() => webview.setRequestHandler(null)),
  setFileDropHandler: codeOf(() => webview.setFileDropHandler(null)),
  bind: codeOf(() => webview.bind("late", () => 0)),
});
const page = (script: string) =>
  webview.setAsset("index.html", "text/html; charset=utf-8", `<!doctype html><body style="margin:0;height:100vh"><script>addEventListener("dragover", (e) => e.preventDefault()); addEventListener("drop", (e) => e.preventDefault()); (async () => { ${script} })();</script></body>`);

if (scenario === "throws") {
  const dropOne = await fileDrop("one.txt");
  const dropTwo = await fileDrop("two.txt");
  const steps: string[] = [];
  // A binding: through bind, a throw rejects the page's call; through
  // bindRaw, it reaches the binding's backstop and is logged.
  webview.bind("bindThrows", () => {
    throw new Error("bind boom");
  });
  webview.bindRaw("rawThrows", () => {
    throw new Error("raw boom");
  });
  // Request handlers: the Webview wrapper answers 500 itself; the engine's
  // backstop logs and answers 500.
  webview.setRequestHandler((req) => {
    if (new URL(req.url).pathname === "/throws") throw new Error("handler boom");
    return { body: "ok" };
  });
  webview.bind("engineRequestHandler", () => {
    engine.setRequestHandler((req) => {
      if (req.url.endsWith("/engine-throws")) throw new Error("engine handler boom");
      native.completeRequest(webview.unsafeHandle!, req.id, 200, null, new TextEncoder().encode("engine ok"));
    });
    return true;
  });
  // File drop handlers: the wrapper swallows; the engine's backstop logs.
  webview.bind("drops", () => {
    webview.setFileDropHandler(() => {
      steps.push("wrapper drop");
      throw new Error("drop boom");
    });
    dropOne();
    after(400, () => {
      engine.setFileDropHandler(() => {
        steps.push("engine drop");
        throw new Error("engine drop boom");
      });
      dropTwo();
    });
    return true;
  });
  // New-window and navigation-failed handlers.
  engine.onNewWindowRequested(() => {
    steps.push("new window");
    throw new Error("new-window boom");
  });
  webview.bind("stillAnswering", (r: Record<string, unknown>) => {
    report.page = r;
    report.steps = steps;
    native.quitLoop();
  });
  page(`
    const r = {};
    try { await window.bindThrows(); r.bindThrows = "resolved"; } catch (e) { r.bindThrows = e; }
    window.rawThrows();
    r.wrapperThrows = (await fetch("/throws")).status;
    r.afterWrapperThrow = await (await fetch("/fine")).text();
    await window.engineRequestHandler();
    r.engineThrows = (await fetch("/engine-throws")).status;
    r.afterEngineThrow = await (await fetch("/fine")).text();
    await window.drops();
    await new Promise((res) => setTimeout(res, 1200));
    window.open(${JSON.stringify(origin)} + "/popup");
    await new Promise((res) => setTimeout(res, 300));
    sessionStorage.r = JSON.stringify(r);
    location.href = "http://127.0.0.1:9/";
  `);
  webview.setAsset("after.html", "text/html", `<!doctype html><script>window.stillAnswering(JSON.parse(sessionStorage.r || "{}"))</script>`);
  // After the failed navigation, a page of the asset origin again.
  engine.onNavigationFailed(() => {
    steps.push("navigation failed");
    after(100, () => webview.navigate(`${origin}/after.html`));
    throw new Error("navigation-failed boom");
  });
  webview.navigate(`${origin}/index.html`);
  webview.run();
  finish();
}

if (scenario === "remove-self") {
  const calls: string[] = [];
  // A new-window handler replaces itself; the replacement clears itself.
  engine.onNewWindowRequested(() => {
    calls.push("A popup");
    engine.onNewWindowRequested(() => {
      calls.push("B popup");
      engine.onNewWindowRequested(null);
    });
  });
  // A navigation-failed handler clears itself.
  engine.onNavigationFailed(() => {
    calls.push("navigation failed");
    engine.onNavigationFailed(null);
    after(100, () => webview.navigate("http://127.0.0.1:9/again"));
    after(1500, () => native.quitLoop());
  });
  webview.bind("opened", () => {
    after(300, () => webview.navigate("http://127.0.0.1:9/"));
  });
  page(`window.open(${JSON.stringify(origin)} + "/one"); await new Promise((r) => setTimeout(r, 200)); window.open(${JSON.stringify(origin)} + "/two"); await new Promise((r) => setTimeout(r, 200)); window.opened();`);
  webview.navigate(`${origin}/index.html`);
  webview.run();
  report.calls = calls;
  finish();
}

if (scenario === "destroy-new-window" || scenario === "destroy-navigation-failed") {
  const destroyInside = () => {
    webview.destroy();
    report.insideCall = destroyedCodes();
  };
  if (scenario === "destroy-new-window") engine.onNewWindowRequested(destroyInside);
  else engine.onNavigationFailed(destroyInside);
  page(scenario === "destroy-new-window" ? `window.open(${JSON.stringify(origin)} + "/popup");` : `location.href = "http://127.0.0.1:9/";`);
  webview.navigate(`${origin}/index.html`);
  webview.run();
  report.runReturned = true;
  report.released = webview.unsafeHandle === null && engine.destroyed;
  finish();
}

/**
 * Asks for the foreground for `hwnd` up to eight times, a short wait apart (other sessions take
 * it), then runs `then`; when it is never granted, records `foreground: false` and the reason and
 * ends the loop with nothing pressed.
 */
function whenForeground(hwnd: number | bigint, then: () => void, attempt = 1): void {
  if (probe.takeForeground(hwnd)) {
    report.foreground = true;
    report.foregroundAttempts = attempt;
    then();
    return;
  }
  if (attempt >= 8) {
    report.foreground = false;
    report.foregroundRefused = `the desktop did not give this process the foreground in ${attempt} attempts`;
    native.quitLoop();
    return;
  }
  after(250, () => whenForeground(hwnd, then, attempt + 1));
}

/**
 * Taps `virtualKey` into `hwnd`, taking the foreground back first if another session took it.
 * When it cannot, the run counts as one without the foreground (the test runs it again or skips).
 */
function tapInForeground(hwnd: number | bigint, virtualKey: number): boolean {
  if (!probe.takeForeground(hwnd)) {
    report.foreground = false;
    report.foregroundRefused = "another session took the foreground during the run and it could not be taken back";
    native.quitLoop();
    return false;
  }
  return probe.tapKey(hwnd, virtualKey);
}

if (scenario === "accelerator-destroy") {
  // An accelerator-key handler destroys its own webview from inside its call. Needs the
  // foreground, as above.
  const hwnd = webview.unsafeWindowHandle!;
  const keys: number[] = [];
  engine.onAcceleratorKey((key) => {
    // Other sessions press keys system-wide while this window has the foreground: only F12 is ours.
    if (key.virtualKey !== 0x7b) return false;
    keys.push(key.virtualKey);
    webview.destroy();
    report.insideCall = destroyedCodes();
    return true;
  });
  webview.bind("ready", () =>
    whenForeground(hwnd, () => {
      engine.moveFocus();
      const VK_F12 = 0x7b;
      const taps: boolean[] = [];
      report.taps = taps;
      after(200, () => taps.push(tapInForeground(hwnd, VK_F12)));
      // run() returns when the handler destroys the webview; this only bounds a run where it did not.
      after(3000, () => native.quitLoop());
    }),
  );
  page(`window.ready();`);
  webview.navigate(`${origin}/index.html`);
  webview.run();
  report.runReturned = true;
  report.released = webview.unsafeHandle === null && engine.destroyed;
  report.windowGone = !probe.isWindow(hwnd);
  report.keys = keys;
  finish();
}

if (scenario === "accelerator") {
  // AcceleratorKeyPressed is raised only for real keyboard input to a
  // focused webview, so this needs the foreground; a shared desktop may
  // refuse it, and then nothing is pressed.
  const hwnd = webview.unsafeWindowHandle!;
  const keys: number[] = [];
  engine.onAcceleratorKey((key) => {
    // Other sessions press keys system-wide while this window has the foreground: only F12 is ours.
    if (key.virtualKey !== 0x7b) return false;
    keys.push(key.virtualKey);
    if (keys.length === 1) throw new Error("accelerator boom");
    // The second clears itself; the third key is not delivered.
    engine.onAcceleratorKey(null);
    return true;
  });
  webview.bind("ready", () => whenForeground(hwnd, () => {
    engine.moveFocus();
    // F12 opens the developer tools only with `debug`, which is off here.
    const VK_F12 = 0x7b;
    const taps: boolean[] = [];
    report.taps = taps;
    after(200, () => taps.push(tapInForeground(hwnd, VK_F12)));
    after(500, () => taps.push(tapInForeground(hwnd, VK_F12)));
    after(800, () => taps.push(tapInForeground(hwnd, VK_F12)));
    after(1300, () => native.quitLoop());
  }));
  page(`window.ready();`);
  webview.navigate(`${origin}/index.html`);
  webview.run();
  report.keys = keys;
  finish();
}

throw new Error(`unknown scenario ${scenario}`);
