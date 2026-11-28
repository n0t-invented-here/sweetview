// Opens a real webview, serves a page through the request handler and the
// asset table, and prints one line `RESULT <json>` with what the page saw.
// Run by src/request-handler.test.ts in a child process with its own WebView2
// profile. No sockets: every response comes from WebResourceRequested.
//
// Brought over from the bindings' test/fixtures/live-request-handler.ts
// (checklist item W2.7). What changed with the API: the webview is the native
// package's `Webview`; `webview_terminate` is the binding's `quitLoop`; the
// raw C call is the binding's `completeRequest`. What the engine does with a
// request (the query string, refused header JSON, a service worker's fetch,
// the frames origin's isolation, an event split over writes, drops) is proven
// in Rust: `crates/sweetview-platform-webview/tests/serving_os.rs` and
// `crates/sweetview-runtime/src/engine_os_tests.rs`. What stays here is the
// TypeScript: the wrappers, their conversions and checks, and a Worker
// answering through them.

import { binding } from "../../src/binding";
import { completeWebviewRequest, Webview, WebviewError, writeWebviewResponseChunk, type WebviewRequest } from "../../src/index";
import { watchdog } from "./kit";

watchdog(60_000);
const native = binding();
const webview = new Webview(false, { width: 800, height: 600, hint: 0 });
const handle = webview.unsafeHandle;
if (!handle) throw new Error("the webview has no handle");
const origin = webview.assetOrigin;
const frames = webview.framesOrigin;

const seen: { method: string; url: string }[] = [];
const report: Record<string, unknown> = {
  assetOrigin: origin,
  framesOrigin: frames,
  handleType: typeof handle,
};

webview.setAllowExternalDrop(false);
webview.setAllowExternalDrop(true);
report.externalDrop = "ok";

webview.setFileDropHandler(() => {});
webview.setFileDropHandler(null);
webview.setFileDropHandler(() => {});
report.fileDropSetClear = "ok";

webview.setAsset("static.js", "text/javascript; charset=utf-8", "window.staticScript = 'static-ok';");
webview.setAsset("asset.txt", "text/plain; charset=utf-8", "asset-text");

const worker = new Worker(new URL("./complete-worker.ts", import.meta.url).href);
await new Promise<void>((resolve) => {
  worker.onmessage = (e) => {
    if (e.data === "ready") resolve();
  };
});

const page = `<!doctype html>
<html><head><meta charset="utf-8">
<script src="/static.js"></script>
</head><body>
<img id="img" src="/dynamic.png">
<script>
(async () => {
  const r = {};
  try {
    r.parentOrigin = window.origin;
    r.staticScript = window.staticScript || null;
    r.staticFetch = await (await fetch("/asset.txt")).text();

    const resp = await fetch("/api/echo", {
      method: "POST",
      headers: { "X-Sweetview-Test": 'hello "world"', "Content-Type": "application/json" },
      body: JSON.stringify({ ping: "pong", n: 42 }),
    });
    r.echoStatus = resp.status;
    r.echoContentType = resp.headers.get("content-type");
    r.echoMulti = resp.headers.get("x-multi");
    r.echoInjected = resp.headers.get("x-injected");
    r.echoEvil = resp.headers.get("x-evil");
    r.wrapperRejections = resp.headers.get("x-wrapper-rejections");
    r.echo = await resp.json();

    const img = document.getElementById("img");
    r.imgEvent = await new Promise((res) => {
      if (img.complete && img.naturalWidth) return res("load");
      img.onload = () => res("load");
      img.onerror = () => res("error");
    });
    r.img = { w: img.naturalWidth, h: img.naturalHeight };

    r.missingStatus = (await fetch("/nothing-here")).status;

    r.sse = await new Promise((resolve) => {
      const events = [];
      const es = new EventSource("/sse");
      const timer = setTimeout(() => {
        es.close();
        resolve({ timeout: true, events });
      }, 30000);
      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        events.push({ n: data.n, id: e.lastEventId, data });
        if (data.n < 3) return;
        es.close();
        clearTimeout(timer);
        resolve({ events });
      };
    });
    fetch("/never").catch(() => {});
  } catch (e) {
    r.error = String(e && e.stack || e);
  }
  window.report(JSON.stringify(r));
})();
</script>
</body></html>`;

webview.setRequestHandler((req: WebviewRequest) => {
  seen.push({ method: req.method, url: req.url });
  if (process.env.SV_DEBUG) console.error("handler", req.method, req.url);
  const url = new URL(req.url);
  if (url.pathname === "/dynamic") {
    return { headers: [["Content-Type", "text/html; charset=utf-8"]], body: page };
  }
  if (url.pathname === "/api/echo" || url.pathname === "/dynamic.png" || url.pathname === "/sse") {
    worker.postMessage({ handle, request: req });
    return;
  }
  if (url.pathname === "/never") {
    report.neverOpened = true;
    finishWhenDone();
    return;
  }
  return { status: 404, body: "not found" };
});

function finishWhenDone() {
  if (report.page && report.neverOpened) {
    report.requests = seen;
    native.quitLoop();
  }
}

webview.bind("report", (json: string) => {
  report.page = JSON.parse(json);
  finishWhenDone();
});

webview.navigate(`${origin}/dynamic`);
webview.run(); // destroys the webview when it returns

try {
  completeWebviewRequest(handle, 1n, { status: 200, body: "late" });
  report.afterDestroyMain = 0;
} catch (e) {
  report.afterDestroyMain = e instanceof WebviewError ? e.code : String(e);
}
try {
  webview.completeRequest(1n, { status: 200, body: "late" });
  report.afterDestroyMethod = 0;
} catch (e) {
  report.afterDestroyMethod = e instanceof WebviewError ? e.code : String(e);
}
try {
  writeWebviewResponseChunk(handle, 1n, new Uint8Array(0));
  report.emptyChunkAfterDestroy = 0;
} catch (e) {
  report.emptyChunkAfterDestroy = e instanceof WebviewError ? e.code : String(e);
}
report.afterDestroyWorker = await new Promise((resolve) => {
  worker.onmessage = (e) => {
    if (e.data?.afterDestroy) resolve(e.data.afterDestroy);
  };
  worker.postMessage({ handle, afterDestroy: { id: "1" } });
});
worker.terminate();
console.log("RESULT " + JSON.stringify(report));
process.exit(0);
