// Checklist group W2 (the webview) and W1.3 / W1.4 for the webview's callback
// kinds: what the Webview class does in TypeScript (its defaults, the values
// and errors it converts, the checks it makes before the native call, the
// callbacks it catches) against a real WebView2. Each test runs a fixture in
// its own process with its own WebView2 profile and reads its `RESULT <json>`
// line. What the engine does is proven in Rust:
// `crates/sweetview-runtime/src/engine_os_tests.rs` (windows and size hints,
// init, bindings and handlers changing from inside their own calls, pages
// loading from a server, transparency on the screen, real F12, teardown) and
// `crates/sweetview-platform-webview/tests/` (assets, requests, streaming,
// drops).

import { describe, expect, test } from "bun:test";
import { runFixture } from "../test/run-fixture";

const onWindows = process.platform === "win32";
const api = (scenario: string) => runFixture("webview-api.ts", [scenario]);
const serving = (scenario: string) => runFixture("webview-serving.ts", [scenario]);
const callbacks = (scenario: string) => runFixture("webview-callbacks.ts", [scenario]);

describe.if(onWindows)("W2.1 the Webview class", () => {
  test("W2.1 the default size is 1024x768 with no hint, also for an explicit undefined; the handles are numbers, a given window is named, and run() destroys the webview", async () => {
    const { r, exitCode } = await api("wrapper");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r).toMatchObject({
      defaultSize: true,
      undefinedSize: true,
      handleType: "number",
      windowHandleType: "number",
      ownDestroyedByRun: true,
      windowHandleIsGiven: true,
      mountedDestroyedByRun: true,
      givenWindowKept: true,
    });
  }, 60_000);

  test("W2.1 new Webview(handle), bind, bindRaw, return: values and errors both ways, eval through either object, destroy twice from inside a binding", async () => {
    const { r, exitCode } = await api("content");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    // new Webview(handle) names the same webview; a handle that names none throws.
    expect(r.twinSameHandle).toBe(true);
    expect(r.unknownHandle).toEqual({ fn: "webview_create", code: -1 });
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
    // eval through the second object reaches the page.
    expect(r.evaluated).toBe("page");
    // destroy from inside a binding, twice: idempotent; the other object then answers -3.
    expect(r.destroyedInsideBinding).toBe(true);
    expect(r.twinAfterDestroy).toBe(-3);
  }, 60_000);

  test("W2.1 new Webview(true, size): made with debug on, its window is real and its page answers a binding", async () => {
    const { r, exitCode } = await api("debug");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.isWindow).toBe(true);
    expect(r.answered).toBe(42);
  }, 60_000);

  test("W2.1 unload() destroys every webview this process made, and closes the windows they made", async () => {
    const { r, exitCode } = await api("unload");
    expect(exitCode).toBe(0);
    expect(r).toMatchObject({ ownDestroyed: true, mountedDestroyed: true, ownWindowGone: true, givenWindowKept: true });
  }, 60_000);
});

describe.if(onWindows)("W2.3 background colour", () => {
  test("W2.3 setBackgroundColor: alpha 0 and 255 accepted, any other alpha -1, a bad channel -2, a destroyed webview -3", async () => {
    const { r, exitCode } = await serving("background-codes");
    expect(exitCode).toBe(0);
    expect(r.codes).toEqual({ transparent: 0, opaque: 0, alpha1: -1, fraction: -2, negative: -2, over: -2, alphaOver: -2, nan: -2 });
    expect(r.afterDestroy).toBe(-3);
  }, 60_000);
});

describe.if(onWindows)("W2.4 requests", () => {
  test("W2.4 the 500 rule: a throwing handler and a refused response 500, a second answer ignored, the method and body reach the handler", async () => {
    const { r, exitCode } = await serving("requests-500");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.page).toEqual({
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
  // completeWebviewRequest from a Worker and header validation through the
  // wrappers: request-handler.test.ts, "W2.7 dynamic HTML, POST echo, ...".
});

describe.if(onWindows)("W2.5 streaming", () => {
  test("W2.5 beginResponse, writeResponseChunk, endResponse on the UI thread: every kind of chunk in order, a bad status -2 with the request still open, -3 after destroy", async () => {
    const { r, exitCode } = await serving("streaming");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    // Every chunk (string, Uint8Array, ArrayBuffer) in order.
    expect(r.page.stream).toEqual({ status: 200, body: "one,two,three" });
    // A bad status is refused with -2 before anything is sent; the request stays open.
    expect(r.badHeadStatus).toBe(-2);
    expect(r.page.badStatus).toEqual({ status: 200, body: "open after refusal" });
    // After destroy, every step throws -3, an empty chunk included.
    expect(r.afterDestroy).toEqual({ begin: -3, write: -3, writeEmpty: -3, end: -3 });
  }, 60_000);
  // The worker forms (beginWebviewResponse and friends from a Worker):
  // request-handler.test.ts, "W2.7 dynamic HTML, ...".
});

describe.if(onWindows)("W1.3 the webview's callback kinds", () => {
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
  // Handlers that replace, clear or destroy from inside their own calls:
  // `engine_os_tests.rs`.
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

const accelerator = onWindows ? await withForeground("accelerator") : undefined;
test.skipIf(accelerator?.r.foreground !== true)("W1.3 / W1.4 an accelerator-key handler that throws is logged and the loop goes on; it then clears itself (needs the foreground)", () => {
  const { r, stderr } = accelerator!;
  expect(r.taps).toEqual([true, true, true]);
  expect(r.keys).toEqual([0x7b, 0x7b]);
  expect(stderr).toContain("sweetview: an accelerator key handler threw: Error: accelerator boom");
});
