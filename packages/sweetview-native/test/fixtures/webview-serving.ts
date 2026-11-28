// What the Webview class does with background colours (W2.3), the request
// handler's answers (W2.4) and streaming from the UI thread (W2.5): the
// conversions and checks made in TypeScript, against a real WebView2. One
// scenario per process (argv[2]); prints `RESULT <json>`. Run by
// src/webview.test.ts in a child process with its own WebView2 profile. The
// rules the engine applies (assets, the 404 rule, stream heads, drops,
// teardown) are proven in Rust: `crates/sweetview-platform-webview/tests/`
// and `crates/sweetview-runtime/src/engine_os_tests.rs`.

import { SizeHint, Webview, type WebviewRequest, type WebviewResponse } from "../../src/webview";
import { codeOf, finish, native, report, watchdog } from "./kit";

watchdog(40_000);
const scenario = process.argv[2];
report.scenario = scenario;
const tag = `sweetview w2 ${scenario} ${process.pid}`;

/** A webview in a window of its own whose page reports through `report(json)`; run() returns once it has. */
function pageRun(webview: Webview, script: string, onReport?: (value: any) => void) {
  webview.bind("report", (value: unknown) => {
    report.page = value;
    onReport?.(value);
    native.quitLoop();
  });
  webview.setAsset("index.html", "text/html; charset=utf-8", `<!doctype html><title>${tag}</title><body><script>(async () => { try { ${script} } catch (e) { window.report({ error: String(e && e.stack || e) }); } })();</script></body>`);
  webview.navigate(`${webview.assetOrigin}/index.html`);
  webview.run();
}

if (scenario === "background-codes") {
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  report.codes = {
    transparent: codeOf(() => webview.setBackgroundColor(0, 0, 0, 0)),
    opaque: codeOf(() => webview.setBackgroundColor(255, 255, 255, 255)),
    alpha1: codeOf(() => webview.setBackgroundColor(0, 0, 0, 1)),
    fraction: codeOf(() => webview.setBackgroundColor(0.5, 0, 0, 255)),
    negative: codeOf(() => webview.setBackgroundColor(0, -1, 0, 255)),
    over: codeOf(() => webview.setBackgroundColor(0, 0, 256, 255)),
    alphaOver: codeOf(() => webview.setBackgroundColor(0, 0, 0, 256)),
    nan: codeOf(() => webview.setBackgroundColor(Number.NaN, 0, 0, 255)),
  };
  webview.destroy();
  report.afterDestroy = codeOf(() => webview.setBackgroundColor(0, 0, 0, 0));
  finish();
}

if (scenario === "requests-500") {
  // W2.4: a handler that throws, or returns a response that is refused,
  // answers 500; a request answered twice keeps its first answer; the
  // request's method and body reach the handler.
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  webview.setRequestHandler((req: WebviewRequest): WebviewResponse | void => {
    const path = new URL(req.url).pathname;
    if (path === "/index.html") return { headers: { "Content-Type": "text/html; charset=utf-8" }, body: page };
    if (path === "/throws") throw new Error("handler threw");
    if (path === "/bad-header") return { headers: { "Bad Name": "x" }, body: "never" };
    if (path === "/bad-status") return { status: 600 };
    if (path === "/twice") {
      webview.completeRequest(req.id, { body: "first" });
      report.secondAnswer = codeOf(() => webview.completeRequest(req.id, { body: "second" }));
      return;
    }
    if (path === "/body") return { headers: { "X-Method": req.method, "X-Body": req.body === null ? "null" : String(req.body.length) } };
    if (path === "/sync") return { status: 204 };
    return;
  });
  const page = `<!doctype html><title>${tag}</title><body><script>(async () => {
    const status = async (url, init) => { try { const r = await fetch(url, init); return r.status; } catch (e) { return "error:" + e.name; } };
    const r = {};
    r.throws = await status("/throws");
    r.afterThrow = await status("/sync");
    r.badHeader = await status("/bad-header");
    r.badStatus = await status("/bad-status");
    const twice = await fetch("/twice");
    r.twice = { status: twice.status, body: await twice.text() };
    const get = await fetch("/body");
    r.getBody = get.headers.get("x-body");
    const post = await fetch("/body", { method: "POST", body: "12345" });
    r.postBody = { method: post.headers.get("x-method"), length: post.headers.get("x-body") };
    window.report(r);
  })();</script></body>`;
  webview.bind("report", (value: unknown) => {
    report.page = value;
    native.quitLoop();
  });
  webview.navigate(`${webview.assetOrigin}/index.html`);
  webview.run();
  finish();
}

if (scenario === "streaming") {
  // W2.5 from the UI thread, through the Webview methods: every kind of chunk
  // (string, Uint8Array, ArrayBuffer) in order; a status out of range is
  // refused with -2 before the native call and the request stays open; after
  // destroy every step throws -3, an empty chunk included.
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  webview.setRequestHandler((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/stream") {
      webview.beginResponse(req.id, { headers: { "Content-Type": "text/plain" } });
      webview.writeResponseChunk(req.id, "one,");
      webview.writeResponseChunk(req.id, new TextEncoder().encode("two,"));
      webview.writeResponseChunk(req.id, new TextEncoder().encode("three").buffer);
      webview.endResponse(req.id);
      return;
    }
    if (path === "/bad-status") {
      report.badHeadStatus = codeOf(() => webview.beginResponse(req.id, { status: 99 }));
      webview.completeRequest(req.id, { body: "open after refusal" });
      return;
    }
    return { status: 404 };
  });
  pageRun(
    webview,
    `const read = async (p) => { const r = await fetch(p); return { status: r.status, body: await r.text() }; };
    window.report({ stream: await read("/stream"), badStatus: await read("/bad-status") });`,
  );
  const id = 1n;
  report.afterDestroy = {
    begin: codeOf(() => webview.beginResponse(id)),
    write: codeOf(() => webview.writeResponseChunk(id, "x")),
    writeEmpty: codeOf(() => webview.writeResponseChunk(id, "")),
    end: codeOf(() => webview.endResponse(id)),
  };
  finish();
}

throw new Error(`unknown scenario ${scenario}`);
