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
//   included) is refused with -3 by every one of them: proven in Rust
//   (`crates/sweetview-napi/tests/stale_handles.rs`); this file checks they
//   are exported.
// - A NULL chunk with a length (-2) has no counterpart: a chunk is a
//   Uint8Array and carries its own length.
// - `pendingCallbackCloses` and the call through a handler's native function
//   pointer were `JSCallback` plumbing. Handlers that replace, clear or
//   destroy from inside their own calls, driven by real requests and drops,
//   are proven in Rust (`crates/sweetview-runtime/src/engine_os_tests.rs`).

import { describe, expect, test } from "bun:test";
import { binding } from "../../sweetview/src/binding";
import { beginWebviewResponse, completeWebviewRequest, endWebviewResponse, serializeBindingError, Webview, WebviewError, writeWebviewResponseChunk } from "../../sweetview/src/raw-webview";
import { runFixture } from "../test/run-fixture";

const onWindows = process.platform === "win32";

describe.if(onWindows)("W2.7 binding exports", () => {
  test("W2.7 the request, streaming and drop functions exist", () => {
    const native = binding();
    for (const fn of [native.completeRequest, native.beginResponse, native.writeResponseChunk, native.endResponse, native.Engine.fromHandle]) {
      expect(typeof fn).toBe("function");
    }
    for (const method of ["setRequestHandler", "setAllowExternalDrop", "setAsset", "setFileDropHandler"] as const) {
      expect(typeof native.Engine.prototype[method]).toBe("function");
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
  test("W2.7 dynamic HTML, POST echo and a binary image answered from a Worker, static assets, streaming from a Worker, teardown", async () => {
    const { r, exitCode } = await runFixture("live-request-handler.ts");
    // run() returned, the webview was destroyed with a request still open, and the process exited cleanly.
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    const p = r.page;
    const origin = r.assetOrigin;

    expect(p.error).toBeUndefined();
    expect(r.handleType).toBe("number");
    expect(r.externalDrop).toBe("ok");
    // setFileDropHandler registers and clears without error.
    expect(r.fileDropSetClear).toBe("ok");

    // Dynamic HTML from the handler at the main origin.
    expect(origin).toBe("http://webview.localhost");
    expect(r.framesOrigin).toBe("http://frames.webview.localhost");
    expect(p.parentOrigin).toBe(origin);
    // Static assets set as strings answer first, from setAsset.
    expect(p.staticScript).toBe("static-ok");
    expect(p.staticFetch).toBe("asset-text");
    const paths = r.requests.map((q: { url: string }) => new URL(q.url).pathname);
    expect(paths).not.toContain("/static.js");
    expect(paths).not.toContain("/asset.txt");

    // POST with a body and a custom header, answered asynchronously from a Worker.
    expect(p.echoStatus).toBe(201);
    expect(p.echoContentType).toBe("application/json");
    expect(p.echo.method).toBe("POST");
    expect(p.echo.header).toBe('hello "world"');
    expect(JSON.parse(p.echo.body)).toEqual({ ping: "pong", n: 42 });
    // Repeated headers given as pairs survive.
    expect(p.echoMulti).toBe("a, b");
    // Bad headers are refused by completeWebviewRequest with WebviewError -2
    // before anything is queued, and the request stays open for the real answer.
    expect(p.wrapperRejections).toBe("-2,-2,-2,-2");
    // Nothing was injected.
    expect(p.echoInjected).toBeNull();
    expect(p.echoEvil).toBeNull();

    // Binary image completed from a worker thread.
    expect(p.imgEvent).toBe("load");
    expect(p.img).toEqual({ w: 1, h: 1 });

    // A handler's { status: 404 } answers 404.
    expect(p.missingStatus).toBe(404);
    expect(paths).toContain("/nothing-here");

    {
      // Server-Sent Events streamed from a worker through the wrappers: all
      // three arrive in order, as separate events. A bad status is refused
      // (-2) before anything is sent; a second begin for the same request is
      // WEBVIEW_ERROR_DUPLICATE (1).
      const sse = p.sse;
      expect(sse.timeout).toBeUndefined();
      expect(sse.events.map((e: { n: number }) => e.n)).toEqual([1, 2, 3]);
      expect(sse.events.map((e: { id: string }) => e.id)).toEqual(["1", "2", "3"]);
      const last = sse.events[2].data;
      expect(last.badStatus).toBe(-2);
      expect(last.duplicateBegin).toBe(1);
    }

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
