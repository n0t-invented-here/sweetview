// Webview.bind and bindRaw against a real webview. One scenario per process
// (the name is argv[2]); prints one line `RESULT <json>`. Run by
// src/request-handler.test.ts in a child process with its own WebView2
// profile, so a page call that never settles fails the test instead of
// hanging the run.
//
// Brought over from the bindings' test/fixtures/live-bind.ts (W2.7). The old
// fixture read the package's `instances` array to show a destroyed webview
// leaves it; that array is private now, so the same is shown through what an
// application sees: the handle is gone, the engine is released, and
// `unload()` finds nothing left to destroy.

import { engineOf, unload, Webview, WebviewError } from "../../../sweetview/src/raw-webview";
import { watchdog } from "./kit";

watchdog(30_000);
const scenario = process.argv[2];
const report: Record<string, unknown> = { scenario };

// What fn throws: a WebviewError's code, or a description.
function codeOf(fn: () => void): number | string {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return e instanceof WebviewError ? e.code : String(e);
  }
}

// What is left of a webview after destroy: nothing that names it.
const released = (webview: Webview) => webview.unsafeHandle === null && webview.unsafeWindowHandle === null && engineOf(webview) === undefined;

if (scenario === "results-and-errors") {
  const webview = new Webview(false, { width: 400, height: 300, hint: 0 });
  webview.bind("boom", () => {
    throw new Error("boom");
  });
  webview.bind("throwsObject", () => {
    throw { reason: "plain" };
  });
  webview.bind("nothing", () => undefined);
  webview.bind("original", () => "original");
  let duplicateCalled = false;
  // Already bound: refused with WEBVIEW_ERROR_DUPLICATE (1), and the
  // original binding keeps answering.
  report.duplicate = codeOf(() =>
    webview.bindRaw("original", () => {
      duplicateCalled = true;
    }),
  );
  // Not bound: refused with WEBVIEW_ERROR_NOT_FOUND (2).
  report.unbindUnknown = codeOf(() => webview.unbind("neverBound"));
  webview.bind("done", (json: string) => {
    report.page = JSON.parse(json);
    report.duplicateCalled = duplicateCalled;
    webview.destroy();
  });
  webview.setHTML(`<!doctype html><html><body><script>
(async () => {
  const r = {};
  try {
    await window.boom();
    r.boom = "resolved";
  } catch (e) {
    r.boom = { type: typeof e, value: e };
  }
  try {
    await window.throwsObject();
    r.throwsObject = "resolved";
  } catch (e) {
    r.throwsObject = e;
  }
  const n = await window.nothing();
  r.nothing = typeof n;
  r.original = await window.original();
  window.done(JSON.stringify(r));
})();
</script></body></html>`);
  webview.run();
  report.runReturned = true;
  // Destroyed webviews are released.
  report.releasedAfterRun = released(webview);
  unload();
} else if (scenario === "destroy-unrun-then-run") {
  // A webview destroyed without ever running must not leave a quit message
  // behind that ends the next webview's run() at once.
  const first = new Webview(false, { width: 200, height: 200, hint: 0 });
  first.destroy();
  report.releasedAfterFirst = released(first);
  const second = new Webview(false, { width: 400, height: 300, hint: 0 });
  second.bind("done", () => {
    report.secondPageRan = true;
    second.destroy();
  });
  second.setHTML("<!doctype html><html><body><script>window.done();</script></body></html>");
  second.run();
  report.runReturned = true;
  report.releasedAfterRun = released(second);
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

console.log("RESULT " + JSON.stringify(report));
process.exit(0);
