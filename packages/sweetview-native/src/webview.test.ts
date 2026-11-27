// Checklist group W2 (the webview) beyond what the bindings' own tests prove
// (those are in request-handler.test.ts, W2.7), and W1.3 / W1.4 for the
// webview's callback kinds. Each test runs a fixture in its own process with
// its own WebView2 profile and reads its `RESULT <json>` line.

import { describe, expect, test } from "bun:test";
import { runFixture } from "../test/run-fixture";

const onWindows = process.platform === "win32";
const api = (scenario: string) => runFixture("webview-api.ts", [scenario]);
const serving = (scenario: string) => runFixture("webview-serving.ts", [scenario]);
const callbacks = (scenario: string) => runFixture("webview-callbacks.ts", [scenario]);

describe.if(onWindows)("W2.1 the Webview class", () => {
  test("W2.1 new Webview(debug, size): its own window, the real HWND, title, size with each SizeHint, closed by the user", async () => {
    const { r, exitCode } = await api("own-window");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.handleType).toBe("number");
    expect(r.windowHandleType).toBe("number");
    // unsafeWindowHandle is a window: IsWindow, and GetWindowTextW reads the title set.
    expect(r.isWindow).toBe(true);
    expect(r.title).toBe(true);
    // The first size shows the window: NONE sizes the client area and leaves it resizable.
    expect(r.shownBySize).toBe(true);
    expect(r.noneSize).toBe(true);
    expect(r.noneResizable).toBe(true);
    // The title bar follows the system's dark mode.
    expect(r.darkTitleBarFollowsSystem).toBe(true);
    // FIXED sizes it and takes the resize frame away.
    expect(r.fixedSize).toBe(true);
    expect(r.fixedResizable).toBe(false);
    // MIN and MAX bound what the user can drag it to.
    expect(r.minResizable).toBe(true);
    expect(r.minTracking).toBe(true);
    expect(r.maxTracking).toBe(true);
    // Closing the window destroys the webview and ends run().
    expect(r.runReturnedOnClose).toBe(true);
    expect(r.destroyedOnClose).toBe(true);
    expect(r.windowGone).toBe(true);
  }, 60_000);

  test("W2.1 the default size is 1024x768 with no hint, also for an explicit undefined, and destroy() closes the window at once", async () => {
    const { r, exitCode } = await api("own-window-default");
    expect(exitCode).toBe(0);
    expect(r).toMatchObject({ defaultSize: true, undefinedSize: true, closedAtOnce: true, closedAtOnce2: true });
  }, 60_000);

  test("W2.1 new Webview(debug, size, hwnd): mounted in a given window, which size restyles and resizes but never shows, and the page follows", async () => {
    const { r, exitCode } = await api("given-window");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.windowHandleIsGiven).toBe(true);
    expect(r.notShownBySize).toBe(true);
    expect(r.noneSize).toBe(true);
    expect(r.noneStyle).toBe(true);
    expect(r.title).toBe(true);
    expect(r.fixedSize).toBe(true);
    expect(r.fixedStyle).toBe(true);
    // MIN and MAX change the style only: the C++ library kept the bound for its own window.
    expect(r.minStyleOnly).toBe(true);
    expect(r.maxStyleOnly).toBe(true);
    expect(r.followed400).toBe(true);
    expect(r.followed500).toBe(true);
    // run() destroys the webview; the application's window stays.
    expect(r.destroyedByRun).toBe(true);
    expect(r.givenWindowKept).toBe(true);
  }, 60_000);

  test("W2.1 new Webview(handle), navigate, setHTML, init, eval, bind, bindRaw, return, unbind, destroy from inside a binding", async () => {
    const { r, exitCode } = await api("content");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    // new Webview(handle) names the same webview; a handle that names none throws.
    expect(r.twinSameHandle).toBe(true);
    expect(r.unknownHandle).toEqual({ fn: "webview_create", code: -1 });
    // init runs before the page's own scripts, in every later document:
    // navigate (twice) and setHTML.
    expect(r.pages.map((p: { href: string }) => p.href)).toEqual(["http://webview.localhost/a.html", "http://webview.localhost/b.html", "about:blank"]);
    for (const p of r.pages) {
      expect(p.init).toEqual({ seenAt: "loading", scripts: 0, href: p.href });
    }
    const c = r.calls;
    // bind: values both ways, a thrown Error as its message, promises, results JSON cannot carry.
    expect(c.echo).toEqual({ ok: [1, "two", { three: 3 }, [4], null, true] });
    expect(c.throws).toEqual({ err: "thrown" });
    expect(c.doubleLater).toEqual({ ok: 42 });
    expect(c.rejectsLater).toEqual({ err: "rejected" });
    expect(c.bigint.err).toContain("BigInt");
    expect(c.cycle.err).toContain("cyclic");
    expect(c.fn).toEqual({ ok: "undefined" });
    // bindRaw and return: the raw JSON of the arguments and the extra arg; a nonzero status rejects; "" is undefined.
    expect(c.raw).toEqual({ ok: { req: '["x",2]', arg: { tag: "arg" } } });
    expect(c.rawFail).toEqual({ err: "nope" });
    expect(c.rawEmpty).toEqual({ ok: "undefined" });
    // unbind from inside the binding's own call: the page's function is gone.
    expect(c.gone).toEqual({ ok: "bye" });
    expect(c.goneAfterUnbind).toBe("undefined");
    expect(r.goneCalls).toBe(1);
    // A duplicate name is WEBVIEW_ERROR_DUPLICATE (1); an unknown one WEBVIEW_ERROR_NOT_FOUND (2).
    expect(r.duplicateBind).toBe(1);
    expect(r.unbindUnknown).toBe(2);
    expect(r.unbindAgain).toBe(2);
    // eval runs in the current document, through either object.
    expect(r.evaluated).toEqual({ title: "C", n: 42, fromTwin: "twin" });
    // destroy from inside a binding, twice: idempotent; the other object then answers -3.
    expect(r.destroyedInsideBinding).toBe(true);
    expect(r.twinAfterDestroy).toBe(-3);
  }, 60_000);

  // A page loading from a Bun.serve in the same process: bind, init and unbind
  // return while the load waits for its response, and the next document has
  // all three applied. The hard limit ends the fixture if a call never returns.
  for (const mode of ["pump", "run"] as const) {
    test(`W2.1 bind, init and unbind while the page loads from this process's own server (${mode === "pump" ? "loop pumped from a Bun timer" : "blocking run()"})`, async () => {
      const { r, exitCode } = await runFixture("webview-load-in-flight.ts", [mode], {}, 45_000);
      expect(r.limitReached).toBeUndefined();
      expect(r.steps).toEqual(["bind", "bind returned", "init", "init returned", "unbind", "unbind returned"]);
      expect(exitCode).toBe(0);
      expect(r.timedOut).toBeUndefined();
      // Under the Bun-timer loop the server answers and the page loads; inside
      // run() this process's JavaScript, the server's included, does not run.
      if (mode === "pump") expect(r.firstLoaded).toBe(true);
      else expect(r.runReturned).toBe(true);
      // The next document has the binding made during the load (and it
      // answers), the init script, and not the binding removed during it.
      expect(r.next).toEqual({ page: "second", during: "function", early: "undefined", init: true, duringResult: "during:x" });
    }, 60_000);
  }

  // eval made right after navigate and bind, on a new webview whose
  // navigation is still waiting, runs in the new document: the order the
  // calls were made in, as when bind waited for WebView2.
  for (const mode of ["eval-pump", "eval-run"] as const) {
    test(`W2.1 eval right after navigate and bind on a new webview runs in the new document (${mode === "eval-pump" ? "loop pumped from a Bun timer, page from this process's own server" : "blocking run(), setHTML"})`, async () => {
      const { r, exitCode } = await runFixture("webview-load-in-flight.ts", [mode], {}, 45_000);
      expect(r.limitReached).toBeUndefined();
      expect(exitCode).toBe(0);
      expect(r.timedOut).toBeUndefined();
      expect(r.answeredFrom).toBe("first");
      if (mode === "eval-run") expect(r.runReturned).toBe(true);
    }, 60_000);
  }

  test("W2.1 unload() destroys every webview this process made, and closes the windows they made", async () => {
    const { r, exitCode } = await api("unload");
    expect(exitCode).toBe(0);
    expect(r).toMatchObject({ ownDestroyed: true, mountedDestroyed: true, ownWindowGone: true, givenWindowKept: true });
  }, 60_000);
});

describe.if(onWindows)("W2.2 assets", () => {
  test("W2.2 setAsset and assetOrigin: raw path, trailing slash, query and fragment, leading slashes, replacement, validation", async () => {
    const { r, exitCode } = await serving("assets");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    const p = r.page;
    expect(p.error).toBeUndefined();
    expect(r.assetOrigin).toBe("http://webview.localhost");
    expect(p.origin).toBe("http://webview.localhost");
    const ok = (body: string, type = "text/plain; charset=utf-8") => ({ status: 200, type, body });
    const missing = { status: 404, type: null, body: null };
    // The MIME type is the Content-Type; calling again with the same path replaces the bytes.
    expect(p.a1).toEqual(ok("A1"));
    expect(p.a2).toEqual(ok("A2"));
    // The raw path, not percent-decoded.
    expect(p.rawPercent).toEqual(ok("raw-percent"));
    expect(p.decoded).toEqual(missing);
    // A trailing slash is kept.
    expect(p.dirSlash).toEqual(ok("with-slash"));
    expect(p.dirNoSlash).toEqual(missing);
    expect(p.dir2Slash).toEqual(missing);
    // Leading slashes are ignored, in the asset's path and in the request's.
    expect(p.lead).toEqual(ok("one-leading"));
    expect(p.many).toEqual(ok("many-leading"));
    expect(p.doubleSlashRequest).toEqual(ok("A2"));
    // Query string and fragment are ignored, in the request and in the asset's path.
    expect(p.queryAndFragment).toEqual(ok("A2"));
    expect(p.queryInAssetPath).toEqual(ok("query-in-path"));
    // Bytes and an empty body; a tab is allowed in a header value.
    expect(p.bytes).toEqual({ type: "application/octet-stream", data: [0, 1, 2, 255] });
    expect(p.empty).toEqual(ok(""));
    expect(p.tab).toEqual(ok("tab-ok", "text/plain;\tcharset=utf-8"));
    // Without a handler, a path with no asset is 404.
    expect(p.missing).toEqual(missing);
    // A MIME type with CR, LF, NUL or another control character is WEBVIEW_ERROR_INVALID_ARGUMENT,
    // and the asset table is left as it was (a.txt still answers A1, then A2).
    expect(r.invalid).toEqual([-2, -2, -2, -2, -2]);
    // A destroyed webview is WEBVIEW_ERROR_INVALID_STATE.
    expect(r.afterDestroy).toBe(-3);
  }, 60_000);
});

describe.if(onWindows)("W2.3 background colour", () => {
  test("W2.3 setBackgroundColor: alpha 0 and 255 accepted, any other alpha -1, a bad channel -2, a destroyed webview -3", async () => {
    const { r, exitCode } = await serving("background-codes");
    expect(exitCode).toBe(0);
    expect(r.codes).toEqual({ transparent: 0, opaque: 0, alpha1: -1, alpha128: -1, alpha254: -1, fraction: -2, negative: -2, over: -2, alphaOver: -2, nan: -2 });
    expect(r.afterDestroy).toBe(-3);
  }, 60_000);

  test("W2.3 alpha 0 shows the window behind a transparent window on the screen; alpha 255 hides it", async () => {
    const { r, exitCode } = await serving("transparency");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    // Read from the screen: the green page of the window behind shows through
    // the transparent page; the page's own red square is drawn.
    expect(r.samples.transparent).toEqual({ centre: "#00ff00", square: "#ff0000" });
    // An opaque background colour hides the window behind.
    expect(r.samples.opaqueBlue.centre).not.toBe("#00ff00");
    expect(r.samples.opaqueBlue.square).toBe("#ff0000");
  }, 60_000);
});

describe.if(onWindows)("W2.4 requests", () => {
  test("W2.4 the 404 and 500 rules: no handler 404 on both origins, a throwing handler and a refused response 500, a second answer ignored", async () => {
    const { r, exitCode } = await serving("requests-404-500");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.framesOrigin).toBe("http://frames.webview.localhost");
    expect(r.page).toEqual({
      noHandlerMain: 404,
      noHandlerFrames: "loaded",
      throws: 500,
      afterThrow: 204,
      badHeader: 500,
      badStatus: 500,
      twice: { status: 200, body: "first" },
      getBody: "null",
      postBody: { method: "POST", length: "5" },
    });
    // A second answer to the same request does nothing.
    expect(r.secondAnswer).toBe(0);
  }, 60_000);
  // completeWebviewRequest from a Worker, framesOrigin cross-origin from the
  // page, header validation and a service worker's request reaching the
  // handler: request-handler.test.ts, "W2.7 dynamic HTML, POST echo, ...".
});

describe.if(onWindows)("W2.5 streaming", () => {
  test("W2.5 beginResponse, writeResponseChunk, endResponse on the UI thread: chunks in order, duplicate begin 1, the chunk rules, -3 after destroy", async () => {
    const { r, exitCode } = await serving("streaming");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    // Status, repeated headers and every chunk (string, Uint8Array, ArrayBuffer) in order.
    expect(r.page.stream).toEqual({ status: 201, multi: "a, b", body: "one,two,three" });
    expect(r.duplicateBegin).toBe(1);
    // An empty chunk writes nothing; a second end and a chunk after the end do nothing.
    expect(r.emptyChunk).toBe(0);
    expect(r.secondEnd).toBe(0);
    expect(r.chunkAfterEnd).toBe(0);
    // Beginning a request already answered does nothing, and its chunks are dropped.
    expect(r.beginAfterComplete).toBe(0);
    expect(r.chunkAfterComplete).toBe(0);
    expect(r.page.answered).toEqual({ status: 200, multi: null, body: "completed" });
    // Ending a response never begun does nothing; the request can still be completed.
    expect(r.endUnbegun).toBe(0);
    expect(r.page.unbegun).toEqual({ status: 200, multi: null, body: "still answerable" });
    // A bad head is refused with -2 before anything is sent; the request stays open.
    expect(r.badHeadHeader).toBe(-2);
    expect(r.badHeadStatus).toBe(-2);
    expect(r.page.badHead).toEqual({ status: 200, multi: null, body: "open after refusal" });
    // After destroy, every step throws -3, an empty chunk included.
    expect(r.afterDestroy).toEqual({ begin: -3, write: -3, writeEmpty: -3, end: -3 });
  }, 60_000);
  // The worker forms (beginWebviewResponse and friends from a Worker, with the
  // timing WebView2 gives an EventSource): request-handler.test.ts, "W2.7 dynamic HTML, ...".
});

describe.if(onWindows)("W2.6 drops", () => {
  test("W2.6 a file dropped from the OS reaches setFileDropHandler with its real path; an in-page drag and drop still reaches the page", async () => {
    const { r, exitCode } = await serving("drops");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    // setAllowExternalDrop both ways.
    expect(r.allowFalse).toBe(0);
    expect(r.allowTrue).toBe(0);
    expect(r.fileDrag).toBe(0);
    expect(r.textDrag).toBe(0);
    // The handler got the real path of the one file, once.
    expect(r.handled).toEqual([[r.file]]);
    // The page's own drop listener: the file drop arrives with its default
    // already prevented by the drop script (the browser does not open the
    // file); the in-page text drag arrives untouched while the handler is set.
    expect(r.pageDrops).toEqual([
      { text: "", files: 1, defaultPrevented: true, handlerSet: true },
      { text: "in-page text", files: 0, defaultPrevented: false, handlerSet: true },
    ]);
  }, 60_000);
});

describe.if(onWindows)("W2.9 teardown", () => {
  test("W2.9 destroying a webview with requests open (one pending, one streaming) releases them; run() returns; late answers are -3", async () => {
    const { r, exitCode } = await serving("teardown-open-requests");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.runReturned).toBe(true);
    expect(r.openAtDestroy).toBe(2);
    expect(r.late).toEqual([
      { complete: -3, chunk: -3 },
      { complete: -3, chunk: -3 },
    ]);
  }, 60_000);

  test("W2.9 destroying a webview from inside its request handler", async () => {
    // The same scenario the bindings' test runs, under this item's name.
    const { r, exitCode } = await runFixture("live-callback-teardown.ts", ["request-destroy"]);
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.destroyedInsideCall).toBe(true);
    expect(r.insideCall).toEqual({ completeRequest: -3, setRequestHandler: -3, setFileDropHandler: -3 });
    expect(r.runReturned).toBe(true);
    expect(r.callsAfterDestroy).toBe(0);
  }, 60_000);

  test("W2.9 a worker answering and streaming while the UI thread destroys the webview: accepted before, -3 after, no crash", async () => {
    const { r, exitCode } = await serving("teardown-worker-race");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.runReturned).toBe(true);
    for (const codes of [r.worker.stream, r.worker.complete] as number[][]) {
      // Each call either went through or was refused as destroyed, and once refused, always refused.
      const firstRefused = codes.indexOf(-3);
      expect(codes.length).toBeGreaterThan(1);
      expect(firstRefused).toBeGreaterThan(0);
      expect(codes.slice(0, firstRefused).every((c) => c === 0)).toBe(true);
      expect(codes.slice(firstRefused).every((c) => c === -3)).toBe(true);
    }
  }, 60_000);
});

describe.if(onWindows)("W1.3 / W1.4 the webview's callback kinds", () => {
  test("W1.3 an exception from a binding, a request handler, a file drop handler, a new-window and a navigation-failed handler is caught, logged, and the loop goes on", async () => {
    const { r, stderr, exitCode } = await callbacks("throws");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    // bind rejects the page's call with the message; the request handlers answer 500 and the next request is answered.
    expect(r.page).toEqual({ bindThrows: "bind boom", wrapperThrows: 500, afterWrapperThrow: "ok", engineThrows: 500, afterEngineThrow: "engine ok" });
    // Every handler ran, and the loop went on past each: the last page answered.
    expect(r.steps).toEqual(["wrapper drop", "engine drop", "new window", "navigation failed"]);
    // What reaches the binding is logged with the kind of callback.
    expect(stderr).toContain("sweetview: a binding threw: Error: raw boom");
    expect(stderr).toContain("sweetview: a request handler threw: Error: engine handler boom");
    expect(stderr).toContain("sweetview: a file drop handler threw: Error: engine drop boom");
    expect(stderr).toContain("sweetview: a new-window handler threw: Error: new-window boom");
    expect(stderr).toContain("sweetview: a navigation-failed handler threw: Error: navigation-failed boom");
    // The Webview class's own wrappers catch first, as the bindings' class did: no log for those.
    expect(stderr).not.toContain("Error: handler boom");
    expect(stderr).not.toContain("Error: drop boom");
    expect(stderr.split(/\r?\n/).filter((line) => line.startsWith("sweetview:"))).toHaveLength(5);
  }, 60_000);

  test("W1.4 a new-window handler replaces itself and the replacement clears itself; a navigation-failed handler clears itself", async () => {
    const { r, exitCode } = await callbacks("remove-self");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.calls).toEqual(["A popup", "B popup", "navigation failed"]);
  }, 60_000);

  for (const kind of ["new-window", "navigation-failed"]) {
    test(`W1.4 a ${kind} handler destroys its webview from inside its own call`, async () => {
      const { r, exitCode } = await callbacks(`destroy-${kind}`);
      expect(exitCode).toBe(0);
      expect(r.timedOut).toBeUndefined();
      expect(r.insideCall).toEqual({ setRequestHandler: -3, setFileDropHandler: -3, bind: -3 });
      expect(r.runReturned).toBe(true);
      expect(r.released).toBe(true);
    }, 60_000);
  }
  // A binding that unbinds itself: "W2.1 new Webview(handle), navigate, ...".
  // A request handler and a file drop handler that replace or clear
  // themselves or destroy the webview: request-handler.test.ts, "W2.7 live
  // webview: changes from inside a handler's own call".
});

// AcceleratorKeyPressed is raised only for real keyboard input to a focused
// webview. The fixture taps F12 (three times, each press and release in one
// SendInput batch) only while its own window holds the foreground; a desktop
// that refuses the foreground to a background process leaves this test
// skipped, with nothing pressed. The handler throws on its first call, clears
// itself on its second, and is not called again.
// Other sessions share this desktop and take the foreground, so the fixture asks
// for it up to eight times, and a fixture that never got it is run again, up to
// three runs. A desktop that refuses the foreground to every run leaves the test
// skipped (computed before the test, so the runner shows a skip, never a pass),
// with the reason printed.
async function withForeground(scenario: string) {
  let run = await callbacks(scenario);
  for (let again = 1; again < 3 && run.r.foreground === false; again++) run = await callbacks(scenario);
  if (run.r.foreground !== true) console.warn(`webview.test: ${scenario} skipped: ${run.r.foregroundRefused ?? `no result: ${JSON.stringify(run.r)}`}`);
  return run;
}
// W2.1 with debug on (F40). The fixture is webview-api.ts; the foreground is needed only for F12.
async function apiWithForeground(scenario: string) {
  let run = await api(scenario);
  for (let again = 1; again < 3 && run.r.foreground === false; again++) run = await api(scenario);
  if (run.r.foreground !== true) console.warn(`webview.test: ${scenario}: F12 not pressed: ${run.r.foregroundRefused ?? `no result: ${JSON.stringify(run.r)}`}`);
  return run;
}
const debugOn = onWindows ? await apiWithForeground("debug") : undefined;
const debugOff = onWindows ? await apiWithForeground("no-debug") : undefined;
test.if(onWindows)("W2.1 new Webview(true, size): made with debug on, its window is real and its page answers a binding", () => {
  const { r, exitCode } = debugOn!;
  expect(exitCode).toBe(0);
  expect(r.timedOut).toBeUndefined();
  expect(r.isWindow).toBe(true);
  expect(r.answered).toBe(42);
});
test.skipIf(debugOn?.r.foreground !== true || debugOff?.r.foreground !== true)("W2.1 with debug on, F12 opens the developer tools; with debug off the same key opens none (needs the foreground)", () => {
  expect(debugOn!.r).toMatchObject({ tapped: true, devToolsOpened: true, answered: 42 });
  expect(debugOff!.r).toMatchObject({ tapped: true, devToolsOpened: false, answered: 42 });
});

const accelerator = onWindows ? await withForeground("accelerator") : undefined;
test.skipIf(accelerator?.r.foreground !== true)("W1.3 / W1.4 an accelerator-key handler that throws is logged and the loop goes on; it then clears itself (needs the foreground)", () => {
  const { r, stderr } = accelerator!;
  expect(r.taps).toEqual([true, true, true]);
  expect(r.keys).toEqual([0x7b, 0x7b]);
  expect(stderr).toContain("sweetview: an accelerator key handler threw: Error: accelerator boom");
});

// The handler destroys its own webview from inside its call: run() returns, calls on the webview
// inside the handler already answer "destroyed" (-3), the window is gone and nothing crashed.
const acceleratorDestroy = onWindows ? await withForeground("accelerator-destroy") : undefined;
test.skipIf(acceleratorDestroy?.r.foreground !== true)("W1.4 an accelerator-key handler destroys its webview from inside its own call (needs the foreground)", () => {
  const { r, exitCode } = acceleratorDestroy!;
  expect(exitCode).toBe(0);
  expect(r.timedOut).toBeUndefined();
  expect(r.taps).toEqual([true]);
  expect(r.keys).toEqual([0x7b]);
  expect(r.insideCall).toEqual({ setRequestHandler: -3, setFileDropHandler: -3, bind: -3 });
  expect(r.runReturned).toBe(true);
  expect(r.released).toBe(true);
  expect(r.windowGone).toBe(true);
});
