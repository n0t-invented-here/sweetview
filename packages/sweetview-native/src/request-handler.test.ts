// Checklist item W2.7: the bindings' test/request-handler.test.ts, brought
// over to the native package. The request handler, the frames origin,
// streaming, external drop and bindings against a real WebView2 in a child
// process with its own profile; nothing listens on a socket.
//
// What changed with the API, and what each old assertion became:
// - "library exports": the old test opened the C library with `dlopen` and
//   called each symbol with a NULL webview (-2) and a handle that never came
//   from webview_create (-3). The binding's functions take a handle number;
//   there is no NULL pointer to pass, so a handle that names no webview (0
//   included) is refused with -3 by every one of them.
// - A NULL chunk with a length (-2) has no counterpart: a chunk is a
//   Uint8Array and carries its own length.
// - `pendingCallbackCloses` and the call through a handler's native function
//   pointer were `JSCallback` plumbing; the teardown tests now drive real
//   drops and keep every other assertion.

import { describe, expect, test } from "bun:test";
import { binding } from "../../sweetview/src/binding";
import { beginWebviewResponse, completeWebviewRequest, endWebviewResponse, serializeBindingError, Webview, WebviewError, writeWebviewResponseChunk } from "../../sweetview/src/raw-webview";
import { runFixture } from "../test/run-fixture";

const onWindows = process.platform === "win32";

describe.if(onWindows)("W2.7 binding exports", () => {
  test("W2.7 the request, streaming and drop functions exist, and a handle that names no webview is refused with -3", () => {
    const native = binding();
    for (const fn of [native.completeRequest, native.beginResponse, native.writeResponseChunk, native.endResponse]) {
      expect(typeof fn).toBe("function");
    }
    for (const method of ["setRequestHandler", "setAllowExternalDrop", "setAsset", "setFileDropHandler"] as const) {
      expect(typeof native.Engine.prototype[method]).toBe("function");
    }
    for (const stale of [0, 0x1000]) {
      expect(native.completeRequest(stale, 1n, 200, null, null)).toBe(-3);
      expect(native.completeRequest(stale, 0n, 200, null, null)).toBe(-3);
      expect(native.beginResponse(stale, 1n, 200, null)).toBe(-3);
      expect(native.writeResponseChunk(stale, 1n, new Uint8Array(0))).toBe(-3);
      expect(native.endResponse(stale, 1n)).toBe(-3);
      expect(native.Engine.fromHandle(stale)).toBeNull();
    }
  });
});

// What fn throws: a WebviewError's function name and code.
function thrown(fn: () => void): { fn: string; code: number } | string {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return e instanceof WebviewError ? { fn: e.fn, code: e.code } : String(e);
  }
}

describe("W2.7 argument checks in the bindings", () => {
  // A handle that names no live webview, as after destroy.
  const stale = 0x1000;

  test("W2.7 a status that is not an integer from 100 to 599 is refused with -2 before the native call", () => {
    // 4294967496 wraps to 200 as a C int and 200.5 truncates to 200, so
    // both would pass a range check made after the conversion.
    for (const status of [4294967496, 200.5, 99, 600, Number.NaN]) {
      expect(thrown(() => completeWebviewRequest(stale, 1n, { status }))).toEqual({ fn: "webview_complete_request", code: -2 });
      expect(thrown(() => beginWebviewResponse(stale, 1n, { status }))).toEqual({ fn: "webview_begin_response", code: -2 });
    }
  });

  test("W2.7 setBackgroundColor refuses a channel that is not an integer from 0 to 255 with -2 before the native call", () => {
    // No webview behind it: the channels are refused before the engine is read.
    const webview = Object.create(Webview.prototype) as Webview;
    const bad = [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4294967296];
    for (const value of bad) {
      for (const channel of [0, 1, 2, 3]) {
        const rgba = [0, 0, 0, 255];
        rgba[channel] = value;
        expect(thrown(() => webview.setBackgroundColor(rgba[0]!, rgba[1]!, rgba[2]!, rgba[3]!))).toEqual({ fn: "webview_set_background_color", code: -2 });
      }
    }
  });

  test.if(onWindows)("W2.7 an empty chunk against a destroyed handle is refused with -3, like any chunk", () => {
    for (const chunk of [new Uint8Array(0), new ArrayBuffer(0), "", "x"]) {
      expect(thrown(() => writeWebviewResponseChunk(stale, 1n, chunk))).toEqual({ fn: "webview_write_response_chunk", code: -3 });
    }
    expect(thrown(() => endWebviewResponse(stale, 1n))).toEqual({ fn: "webview_end_response", code: -3 });
  });
});

describe.if(onWindows)("W2.7 live webview", () => {
  test("W2.7 dynamic HTML, POST echo, binary image, cross-origin iframe, static assets, streaming, service worker, teardown", async () => {
    const { r, exitCode } = await runFixture("live-request-handler.ts");
    // run() returned, the webview was destroyed with a request still open, and the process exited cleanly.
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    const p = r.page;
    const origin = r.assetOrigin;
    const frames = r.framesOrigin;

    expect(p.error).toBeUndefined();
    expect(r.handleType).toBe("number");
    expect(r.externalDrop).toBe("ok");
    // setFileDropHandler registers and clears without error.
    expect(r.fileDropSetClear).toBe("ok");

    // Dynamic HTML from the handler at the main origin.
    expect(origin).toBe("http://webview.localhost");
    expect(frames).toBe("http://frames.webview.localhost");
    expect(p.parentOrigin).toBe(origin);
    // Static assets still answer first, from setAsset.
    expect(p.staticScript).toBe("static-ok");
    expect(p.staticFetch).toBe("asset-text");
    const paths = r.requests.map((q: { url: string }) => new URL(q.url).pathname);
    expect(paths).not.toContain("/static.js");
    expect(paths).not.toContain("/asset.txt");

    // POST with a body and a custom header, answered asynchronously.
    expect(p.echoStatus).toBe(201);
    expect(p.echoContentType).toBe("application/json");
    expect(p.echo.method).toBe("POST");
    expect(p.echo.query).toBe("?x=1");
    expect(p.echo.header).toBe('hello "world"');
    expect(JSON.parse(p.echo.body)).toEqual({ ping: "pong", n: 42 });
    // Repeated headers survive.
    expect(p.echoMulti).toBe("a, b");
    // Bad header JSON is refused with WEBVIEW_ERROR_INVALID_ARGUMENT (-2)
    // before anything is queued, and the request stays open for the real
    // answer: trailing text after a literal ({"X-Example":trueish}), an
    // escaped NUL, a name that is not a token, a lone surrogate, a raw tab
    // inside a string, CR LF in a value.
    expect(p.rawRejections).toBe("-2,-2,-2,-2,-2,-2");
    // The same through completeWebviewRequest, which throws WebviewError.
    expect(p.wrapperRejections).toBe("-2,-2,-2,-2");
    // Nothing was injected.
    expect(p.echoInjected).toBeNull();
    expect(p.echoEvil).toBeNull();

    // A service worker's own fetch reaches the handler, not the network.
    expect(p.sw).toEqual({ status: 200, text: "sw-ok" });
    expect(paths).toContain("/sw.js");
    expect(paths).toContain("/from-sw");

    // Binary image completed from a worker thread.
    expect(p.imgEvent).toBe("load");
    expect(p.img).toEqual({ w: 1, h: 1 });

    // Cross-origin iframe from the frames origin: the browser isolates it.
    expect(p.frameOrigin).toBe(frames);
    expect(p.frameEventOrigin).toBe(frames);
    expect(p.frameOrigin).not.toBe(p.parentOrigin);
    expect(p.frameHref).toBe(`${frames}/sandbox.html`);
    expect(String(p.frameDocumentAccess)).toStartWith("blocked:");

    // Seen from inside the iframe: no bridge and no bound functions...
    const f = p.frameProbe;
    expect(f.error).toBeUndefined();
    expect(f.hasBridge).toBe(false);
    // ...no access to the parent document...
    expect(f.parentDocBlocked).toBe("SecurityError");
    // ...no CORS read of the main origin...
    expect(f.crossOriginFetchBlocked).toBe("blocked");
    // ...raw RPC posts to the native channel never run a host binding...
    expect(Array.isArray(f.rawPostAttempted)).toBe(true);
    expect(r.iframeEscaped).toBe(false);
    // ...and its own origin's subresources still load.
    expect(f.subresourceStatus).toBe(200);
    expect(f.subresourceLoaded).toEqual({ frameData: "frame-ok" });
    expect(r.requests.map((q: { url: string }) => q.url)).toContain(`${frames}/frame-data.json`);

    // Unknown paths reach the handler, which answers 404.
    expect(p.missingStatus).toBe(404);
    expect(paths).toContain("/nothing-here");

    {
      // Server-Sent Events streamed from a worker, no socket: all three
      // arrive in order, as separate events (event 2 was written in two
      // halves, 100 ms apart), over one connection, with no reconnect.
      const sse = p.sse;
      expect(sse.timeout).toBeUndefined();
      expect(sse.events.map((e: { n: number }) => e.n)).toEqual([1, 2, 3]);
      expect(sse.events.map((e: { id: string }) => e.id)).toEqual(["1", "2", "3"]);
      expect(paths.filter((q: string) => q === "/sse")).toHaveLength(1);
      const last = sse.events[2].data;
      // WebView2 hands the page an intercepted response only once its body
      // has ended (WebView2Feedback #3519), so every event arrives together,
      // after the last write. If a future WebView2 Runtime delivers partial
      // bodies, the page acks event 1 before event 2 is written and these
      // flip: update the docs of beginWebviewResponse then.
      expect(last.ack1BeforeEvent2).toBe(false);
      expect(last.ack2BeforeEvent3).toBe(false);
      expect(sse.events[0].receivedAt).toBeGreaterThanOrEqual(last.writtenAt);
      // Bad header JSON and a bad status are refused (-2) before anything
      // is sent. A second begin for the same request is
      // WEBVIEW_ERROR_DUPLICATE (1).
      expect(last.badBegin).toBe(-2);
      expect(last.badStatus).toBe(-2);
      expect(last.duplicateBegin).toBe(1);
    }

    // OS file drops: the drop script ran enabled, took a drop carrying
    // files from the page, and let go of drops once the handler was
    // cleared. A File made in script has no path, so the handler never ran.
    expect(p.fileDrop).toEqual({ enabledFlag: true, prevented: true, clearedFlag: false, preventedAfterClear: false });
    expect(r.fileDropCalls).toEqual([]);

    // A request still open when the webview is destroyed is released
    // unanswered, and run() returns.
    expect(r.neverOpened).toBe(true);
    expect(paths).toContain("/never");

    // After destroy, completing against the stale handle is refused with
    // WEBVIEW_ERROR_INVALID_STATE (-3) instead of crashing, from the main
    // thread and from a worker, wrapper and binding call alike.
    expect(r.afterDestroyMain).toBe(-3);
    expect(r.afterDestroyWorker).toEqual({ wrapper: -3, raw: -3 });
    // Webview.completeRequest after destroy() throws -3 too.
    expect(r.afterDestroyMethod).toBe(-3);
    // An empty chunk after destroy is refused with -3, not skipped.
    expect(r.emptyChunkAfterDestroy).toBe(-3);
  }, 90_000);
});

// Replacing, clearing and destroying from inside the handlers' own calls.
// Each scenario runs in its own process, so a teardown that hangs (destroy
// run inside WebView2's WebResourceRequested) fails here.
describe.if(onWindows)("W2.7 live webview: changes from inside a handler's own call", () => {
  // What a destroyed webview answers: WEBVIEW_ERROR_INVALID_STATE (-3).
  const destroyedCodes = { completeRequest: -3, setRequestHandler: -3, setFileDropHandler: -3 };

  test("W2.7 the request handler replaces itself, then the replacement clears itself", async () => {
    const { r, exitCode } = await runFixture("live-callback-teardown.ts", ["request-replace-clear"]);
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.page).toEqual([
      { path: "/a", status: 200, body: "from-A" },
      { path: "/b", status: 200, body: "from-B" },
      // No handler: 404.
      { path: "/c", status: 404, body: expect.any(String) },
    ]);
    // /a went to A, /b to its replacement B, /c to neither.
    expect(r.calls).toContain("A/a");
    expect(r.calls).toContain("B/b");
    expect(r.calls).not.toContain("A/b");
    expect(r.calls.filter((c: string) => c.endsWith("/c"))).toEqual([]);
    expect(r.runReturned).toBe(true);
  }, 90_000);

  test("W2.7 the request handler destroys the webview from inside WebResourceRequested without hanging", async () => {
    const { r, exitCode } = await runFixture("live-callback-teardown.ts", ["request-destroy"]);
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.destroyedInsideCall).toBe(true);
    // Destroyed at once, inside the call: every checked API throws -3.
    expect(r.insideCall).toEqual(destroyedCodes);
    // run() returned and the deferred teardown ran.
    expect(r.runReturned).toBe(true);
    expect(r.afterRun).toEqual(destroyedCodes);
    // Nothing reached the handler once it had destroyed the webview, and
    // the page never got to finish.
    expect(r.callsAfterDestroy).toBe(0);
    expect(r.pageFinished).toBeUndefined();
  }, 90_000);

  test("W2.7 the file drop handler replaces itself, clears itself, and destroys the webview from inside its call", async () => {
    const { r, exitCode } = await runFixture("live-callback-teardown.ts", ["drop-replace-clear-destroy"]);
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.firstDrop).toBe(0);
    expect(r.firstCalled).toBe(true);
    expect(r.secondCalled).toBe(true);
    expect(r.thirdCalled).toBe(true);
    expect(r.fourthCalled).toBe(true);
    // A ran once and handed over to B, which ran once and cleared itself;
    // with no handler the page got the drop; C destroyed the webview.
    expect(r.drops).toEqual(["A:one", "B:two", "page:three", "C:four"]);
    expect(r.insideCall).toEqual(destroyedCodes);
    expect(r.dropAfterDestroy).toBe(-3);
    expect(r.runReturned).toBe(true);
    expect(r.afterRun).toEqual(destroyedCodes);
  }, 90_000);
});

describe("W2.7 binding error serialization", () => {
  test("W2.7 an Error becomes its message, undefined becomes empty, the rest JSON or String()", () => {
    expect(serializeBindingError(new Error("boom"))).toBe('"boom"');
    expect(serializeBindingError(new TypeError("typed"))).toBe('"typed"');
    expect(serializeBindingError(undefined)).toBe("");
    expect(serializeBindingError("plain")).toBe('"plain"');
    expect(serializeBindingError({ reason: "x" })).toBe('{"reason":"x"}');
    expect(serializeBindingError(null)).toBe("null");
    // JSON.stringify throws on a BigInt and on a cycle, and drops a symbol.
    expect(serializeBindingError(10n)).toBe('"10"');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(serializeBindingError(cycle)).toBe('"[object Object]"');
    expect(serializeBindingError(Symbol("s"))).toBe('"Symbol(s)"');
  });
});

describe.if(onWindows)("W2.7 live webview: bindings", () => {
  test("W2.7 bind: a thrown Error rejects with its message, undefined resolves, a duplicate bindRaw is refused with 1 and the original stays", async () => {
    const { r, exitCode } = await runFixture("live-bind.ts", ["results-and-errors"]);
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.page).toEqual({
      boom: { type: "string", value: "boom" },
      throwsObject: { reason: "plain" },
      nothing: "undefined",
      original: "original",
    });
    expect(r.duplicate).toBe(1);
    expect(r.duplicateCalled).toBe(false);
    expect(r.unbindUnknown).toBe(2);
    expect(r.runReturned).toBe(true);
    // Destroyed webviews are released.
    expect(r.releasedAfterRun).toBe(true);
  }, 90_000);

  test("W2.7 destroy() of a webview that never ran does not end the next webview's run()", async () => {
    const { r, exitCode } = await runFixture("live-bind.ts", ["destroy-unrun-then-run"]);
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.releasedAfterFirst).toBe(true);
    expect(r.secondPageRan).toBe(true);
    expect(r.runReturned).toBe(true);
    expect(r.releasedAfterRun).toBe(true);
  }, 90_000);
});
