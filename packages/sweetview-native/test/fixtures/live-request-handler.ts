// Opens a real webview, serves a page through the request handler and the
// asset table, and prints one line `RESULT <json>` with what the page saw.
// Run by src/request-handler.test.ts in a child process with its own WebView2
// profile. No sockets: every response comes from WebResourceRequested.
//
// Brought over from the bindings' test/fixtures/live-request-handler.ts
// (checklist item W2.7). What changed with the API: the webview is the native
// package's `Webview`; `webview_terminate` is the binding's `quitLoop`; the
// raw C call with hand-written header JSON is the binding's `completeRequest`,
// which takes the header JSON text as it is. The file drop handler that
// clears itself inside its own call is in live-callback-teardown.ts, driven
// by a real drop instead of a call through its native pointer.

import { binding } from "../../../sweetview/src/binding";
import { completeWebviewRequest, Webview, WebviewError, writeWebviewResponseChunk, type WebviewRequest } from "../../../sweetview/src/raw-webview";
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

// External drop: both directions succeed (throws otherwise).
webview.setAllowExternalDrop(false);
webview.setAllowExternalDrop(true);
report.externalDrop = "ok";

// OS file drops: registering, clearing and registering again all succeed
// (throws otherwise). Left set, so the page starts with the drop script
// enabled; the page clears it through clearFileDrop below.
const fileDropCalls: string[][] = [];
webview.setFileDropHandler((paths) => fileDropCalls.push(paths));
webview.setFileDropHandler(null);
webview.setFileDropHandler((paths) => fileDropCalls.push(paths));
report.fileDropSetClear = "ok";

// The asset table still answers first, untouched by the handler.
webview.setAsset("static.js", "text/javascript; charset=utf-8", "window.staticScript = 'static-ok';");
webview.setAsset("asset.txt", "text/plain; charset=utf-8", "asset-text");

// Answers /api/echo and /dynamic.png on another thread, after the handler
// returned: the pattern for async work while run() blocks this thread.
const worker = new Worker(new URL("./complete-worker.ts", import.meta.url).href);
await new Promise<void>((resolve) => {
  worker.onmessage = (e) => {
    if (e.data === "ready") resolve();
  };
});

const page = `<!doctype html>
<html><head><meta charset="utf-8">
<script>
  window.frameMessage = new Promise((resolve) => {
    window.addEventListener("message", (e) => resolve({ eventOrigin: e.origin, data: e.data }));
  });
</script>
<script src="/static.js"></script>
</head><body>
<img id="img" src="/dynamic.png">
<iframe id="frame" src="${frames}/sandbox.html"></iframe>
<script>
(async () => {
  const r = {};
  try {
    r.parentOrigin = window.origin;
    r.staticScript = window.staticScript || null;
    r.staticFetch = await (await fetch("/asset.txt")).text();

    const resp = await fetch("/api/echo?x=1", {
      method: "POST",
      headers: { "X-Sweetview-Test": 'hello "world"', "Content-Type": "application/json" },
      body: JSON.stringify({ ping: "pong", n: 42 }),
    });
    r.echoStatus = resp.status;
    r.echoContentType = resp.headers.get("content-type");
    r.echoMulti = resp.headers.get("x-multi");
    r.echoInjected = resp.headers.get("x-injected");
    r.echoEvil = resp.headers.get("x-evil");
    r.rawRejections = resp.headers.get("x-raw-rejections");
    r.wrapperRejections = resp.headers.get("x-wrapper-rejections");
    r.echo = await resp.json();

    const img = document.getElementById("img");
    r.imgEvent = await new Promise((res) => {
      if (img.complete && img.naturalWidth) return res("load");
      img.onload = () => res("load");
      img.onerror = () => res("error");
    });
    r.img = { w: img.naturalWidth, h: img.naturalHeight };

    const msg = await window.frameMessage;
    r.frameEventOrigin = msg.eventOrigin;
    r.frameOrigin = msg.data.origin;
    r.frameHref = msg.data.href;
    r.frameProbe = msg.data;
    try {
      r.frameDocumentAccess = typeof document.getElementById("frame").contentWindow.document;
    } catch (e) {
      r.frameDocumentAccess = "blocked:" + e.name;
    }

    r.missingStatus = (await fetch("/nothing-here")).status;

    // Server-Sent Events streamed from a worker (beginWebviewResponse,
    // writeWebviewResponseChunk, endWebviewResponse). Each event is
    // acknowledged to the host; the worker records whether the ack came
    // before it wrote the next event.
    r.sse = await new Promise((resolve) => {
      const events = [];
      const es = new EventSource("/sse");
      const timer = setTimeout(() => {
        es.close();
        resolve({ timeout: true, events });
      }, 30000);
      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        events.push({ n: data.n, id: e.lastEventId, receivedAt: Date.now(), data });
        if (data.n < 3) {
          window.sseAck(data.n);
          return;
        }
        es.close();
        clearTimeout(timer);
        resolve({ events });
      };
    });

    // OS file drops. The handler was set before navigating, so the drop
    // script starts enabled: a drop carrying a File is kept from the page's
    // default. Clearing the handler hands drops back to the page, in this
    // document too.
    const syntheticDrop = () => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "synthetic.txt", { type: "text/plain" }));
      const ev = new DragEvent("drop", { dataTransfer: dt, cancelable: true, bubbles: true });
      return !document.body.dispatchEvent(ev); // true when prevented
    };
    r.fileDrop = {
      enabledFlag: window.__webview_file_drop_enabled__,
      prevented: syntheticDrop(),
    };
    await window.clearFileDrop();
    r.fileDrop.clearedFlag = window.__webview_file_drop_enabled__;
    r.fileDrop.preventedAfterClear = syntheticDrop();

    // A service worker's own fetch must reach the handler too (WebView2:
    // the filter covers every request source kind), never the network.
    try {
      const reply = new Promise((res) => {
        navigator.serviceWorker.addEventListener("message", (e) => res(e.data));
      });
      navigator.serviceWorker.startMessages();
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      r.swScope = reg.scope;
      const ready = await navigator.serviceWorker.ready;
      ready.active.postMessage("go");
      r.sw = await Promise.race([
        reply,
        new Promise((res) => setTimeout(() => res({ timeout: true }), 15000)),
      ]);
    } catch (e) {
      r.sw = { error: String(e) };
    }
    // Left open on purpose: destroying the webview must release it unanswered.
    fetch("/never").catch(() => {});
  } catch (e) {
    r.error = String(e && e.stack || e);
  }
  window.report(JSON.stringify(r));
})();
</script>
</body></html>`;

// Fetches /from-sw from inside the service worker when the page asks, and
// sends back what it got.
const serviceWorker = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  e.waitUntil(
    fetch("/from-sw?via=service-worker")
      .then(async (r) => ({ status: r.status, text: await r.text() }))
      .catch((err) => ({ error: String(err) }))
      .then((result) => e.source.postMessage(result)),
  );
});
`;

// Runs inside the cross-origin iframe: checks it got no bridge, cannot reach
// the parent or the main origin, cannot call a host binding by posting raw
// RPC messages, and can still load its own origin's subresources. Reports to
// the parent with postMessage.
const sandbox = `<!doctype html><html><body>sandbox
<script>
(async () => {
  const r = { origin: window.origin, href: location.href };
  try {
    r.hasBridge =
      typeof window.__webview__ !== "undefined" ||
      typeof window.iframeProbe !== "undefined" ||
      typeof window.report !== "undefined";
    try {
      void parent.document;
      r.parentDocBlocked = "allowed";
    } catch (e) {
      r.parentDocBlocked = e.name;
    }
    try {
      await fetch(${JSON.stringify(origin)} + "/asset.txt");
      r.crossOriginFetchBlocked = "allowed";
    } catch {
      r.crossOriginFetchBlocked = "blocked";
    }
    // Raw RPC posts straight to the native channel, bypassing __webview__.
    // The host must never run iframeProbe for them.
    const probe = JSON.stringify({ id: "999", method: "iframeProbe", params: [] });
    r.rawPostAttempted = [];
    try {
      if (window.chrome?.webview?.postMessage) {
        window.chrome.webview.postMessage(probe);
        r.rawPostAttempted.push("chrome.webview");
      }
    } catch (e) {
      r.rawPostAttempted.push("chrome.webview:" + e.name);
    }
    try {
      const resp = await fetch("/frame-data.json");
      r.subresourceStatus = resp.status;
      r.subresourceLoaded = await resp.json();
    } catch (e) {
      r.subresourceLoaded = "error:" + e;
    }
  } catch (e) {
    r.error = String(e && e.stack || e);
  }
  parent.postMessage(r, "*");
})();
</script>
</body></html>`;

webview.setRequestHandler((req: WebviewRequest) => {
  seen.push({ method: req.method, url: req.url });
  if (process.env.SV_DEBUG) console.error("handler", req.method, req.url);
  const url = new URL(req.url);
  const isFrames = req.url.startsWith(`${frames}/`);
  if (isFrames && url.pathname === "/sandbox.html") {
    return { headers: { "Content-Type": "text/html; charset=utf-8" }, body: sandbox };
  }
  if (isFrames && url.pathname === "/frame-data.json") {
    // Served to the frames origin only: the iframe's own subresource.
    return { headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ frameData: "frame-ok" }) };
  }
  if (!isFrames && url.pathname === "/dynamic") {
    // Answered synchronously from the handler.
    return { headers: [["Content-Type", "text/html; charset=utf-8"]], body: page };
  }
  if (!isFrames && (url.pathname === "/api/echo" || url.pathname === "/dynamic.png" || url.pathname === "/sse")) {
    // Answered later, from a worker thread, through completeWebviewRequest
    // (/sse: streamed through beginWebviewResponse and friends).
    worker.postMessage({ handle, request: req });
    return;
  }
  if (!isFrames && url.pathname === "/sw.js") {
    return { headers: { "Content-Type": "text/javascript; charset=utf-8" }, body: serviceWorker };
  }
  if (!isFrames && url.pathname === "/from-sw") {
    return { headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "sw-ok" };
  }
  if (!isFrames && url.pathname === "/never") {
    // Never answered; destroying the webview releases it unanswered.
    report.neverOpened = true;
    finishWhenDone();
    return;
  }
  return { status: 404, body: "not found" };
});

// Ends run() once the page has reported and /never is open; run() then
// destroys the webview with that request still pending.
function finishWhenDone() {
  if (report.page && report.neverOpened) {
    report.requests = seen;
    report.iframeEscaped = iframeEscaped;
    report.fileDropCalls = fileDropCalls;
    native.quitLoop();
  }
}

// Never called: the iframe's raw RPC posts must not reach host bindings.
let iframeEscaped = false;
webview.bind("iframeProbe", () => {
  iframeEscaped = true;
});

// Relays the page's Server-Sent Event acks to the streaming worker.
webview.bind("sseAck", (n: number) => {
  worker.postMessage({ sseAck: n });
});

// Clears the file drop handler from inside run(), as an app would.
webview.bind("clearFileDrop", () => {
  webview.setFileDropHandler(null);
  return true;
});

webview.bind("report", (json: string) => {
  report.page = JSON.parse(json);
  finishWhenDone();
});

webview.navigate(`${origin}/dynamic`);
webview.run(); // destroys the webview when it returns

// After destroy: completing against the stale handle is refused with
// WEBVIEW_ERROR_INVALID_STATE (-3), on this thread and on the worker's.
try {
  completeWebviewRequest(handle, 1n, { status: 200, body: "late" });
  report.afterDestroyMain = 0;
} catch (e) {
  report.afterDestroyMain = e instanceof WebviewError ? e.code : String(e);
}
// Webview.completeRequest after destroy() throws the same -3.
try {
  webview.completeRequest(1n, { status: 200, body: "late" });
  report.afterDestroyMethod = 0;
} catch (e) {
  report.afterDestroyMethod = e instanceof WebviewError ? e.code : String(e);
}
// An empty chunk against the destroyed handle still reaches the binding and
// is refused with -3, like a chunk with bytes.
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
