// Assets (W2.2), background colour (W2.3), the request handler's 404 and 500
// rules (W2.4), streaming from the UI thread (W2.5), drops (W2.6) and
// teardown (W2.9), against a real WebView2. One scenario per process
// (argv[2]); prints `RESULT <json>`. Run by src/webview.test.ts in a child
// process with its own WebView2 profile.

import { join } from "node:path";
import { Window } from "../../src/window";
import { completeWebviewRequest, engineOf, SizeHint, Webview, type WebviewRequest } from "../../src/webview";
import { codeOf, finish, native, report, watchdog } from "./kit";
import * as probe from "./win32-probe";

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

if (scenario === "assets") {
  const webview = new Webview(false, { width: 400, height: 300, hint: SizeHint.NONE });
  report.assetOrigin = webview.assetOrigin;
  const text = "text/plain; charset=utf-8";
  webview.setAsset("a.txt", text, "A1");
  webview.setAsset("x%41.txt", text, "raw-percent");
  webview.setAsset("dir/", text, "with-slash");
  webview.setAsset("dir2", text, "no-slash");
  webview.setAsset("/lead.txt", text, "one-leading");
  webview.setAsset("///many.txt", text, "many-leading");
  webview.setAsset("q.txt?ignored=1#frag", text, "query-in-path");
  webview.setAsset("bytes.bin", "application/octet-stream", new Uint8Array([0, 1, 2, 255]));
  webview.setAsset("empty.txt", text, "");
  webview.setAsset("tab.txt", "text/plain;\tcharset=utf-8", "tab-ok");
  // Refused before anything is stored: a MIME type that is not a valid header value.
  report.invalid = ["text/plain\r\nX-Evil: 1", "text/plain\n", "a\0b", "a\u0001b", "a\u007fb"].map((mime) => codeOf(() => webview.setAsset("a.txt", mime, "bad")));
  webview.bind("replace", () => {
    webview.setAsset("a.txt", text, "A2");
    return true;
  });
  pageRun(
    webview,
    `const get = async (path) => { const r = await fetch(path); return { status: r.status, type: r.headers.get("content-type"), body: r.status === 200 ? await r.text() : null }; };
    const r = { origin: location.origin };
    r.a1 = await get("/a.txt");
    await window.replace();
    r.a2 = await get("/a.txt");
    r.rawPercent = await get("/x%41.txt");
    r.decoded = await get("/xA.txt");
    r.dirSlash = await get("/dir/");
    r.dirNoSlash = await get("/dir");
    r.dir2Slash = await get("/dir2/");
    r.lead = await get("/lead.txt");
    r.many = await get("/many.txt");
    r.doubleSlashRequest = await get(location.origin + "//a.txt");
    r.queryAndFragment = await get("/a.txt?x=1&y=2#frag");
    r.queryInAssetPath = await get("/q.txt");
    r.tab = await get("/tab.txt");
    r.empty = await get("/empty.txt");
    const bytes = await fetch("/bytes.bin");
    r.bytes = { type: bytes.headers.get("content-type"), data: [...new Uint8Array(await bytes.arrayBuffer())] };
    r.missing = await get("/nothing.txt");
    window.report(r);`,
  );
  report.afterDestroy = codeOf(() => webview.setAsset("late.txt", text, "late"));
  finish();
}

if (scenario === "background-codes") {
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  report.codes = {
    transparent: codeOf(() => webview.setBackgroundColor(0, 0, 0, 0)),
    opaque: codeOf(() => webview.setBackgroundColor(255, 255, 255, 255)),
    alpha1: codeOf(() => webview.setBackgroundColor(0, 0, 0, 1)),
    alpha128: codeOf(() => webview.setBackgroundColor(0, 0, 0, 128)),
    alpha254: codeOf(() => webview.setBackgroundColor(0, 0, 0, 254)),
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

if (scenario === "transparency") {
  // A green page in a window behind, and in front of it a transparent window
  // whose page is transparent but for a red square in its top-left corner.
  // Pixels are read from the screen: the centre of the front window shows the
  // green window behind it; the square shows red. Then an opaque blue
  // background colour hides the window behind.
  const at = { x: 120, y: 120, width: 320, height: 240 };
  const back = new Window({ title: `${tag} back`, bounds: { x: at.x - 40, y: at.y - 40, width: at.width + 80, height: at.height + 80 }, frame: false, topmost: true, noActivate: true });
  const backView = new Webview(false, undefined, back.handle);
  backView.setHTML(`<!doctype html><body style="margin:0;background:#00ff00"></body>`);
  const front = new Window({ title: `${tag} front`, bounds: at, frame: false, transparent: true, topmost: true, noActivate: true });
  const frontView = new Webview(false, undefined, front.handle);
  frontView.setBackgroundColor(0, 0, 0, 0);
  const sample = () => {
    const r = probe.windowRect(front.handle);
    return { centre: probe.screenPixel(r.x + Math.floor(r.width / 2), r.y + Math.floor(r.height / 2)), square: probe.screenPixel(r.x + 10, r.y + 10) };
  };
  const samples: Record<string, unknown> = {};
  frontView.bind("painted", () => {
    // Give the compositor a few frames.
    native.scheduleTimeout(600, () => {
      samples.transparent = sample();
      frontView.setBackgroundColor(0, 0, 255, 255);
      frontView.eval("document.body.style.outline = '1px solid transparent'");
      native.scheduleTimeout(600, () => {
        samples.opaqueBlue = sample();
        native.quitLoop();
      });
    });
  });
  frontView.setHTML(`<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent">
    <div style="position:absolute;left:0;top:0;width:40px;height:40px;background:#ff0000"></div>
    <script>requestAnimationFrame(() => requestAnimationFrame(() => window.painted()));</script></body></html>`);
  back.show();
  front.show();
  frontView.run();
  report.samples = samples;
  backView.destroy();
  front.dispose();
  back.dispose();
  finish();
}

if (scenario === "requests-404-500") {
  // W2.4: no handler answers 404 on both origins; a handler that throws, or
  // returns a response that is refused, answers 500; a request answered
  // twice keeps its first answer.
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  report.framesOrigin = webview.framesOrigin;
  let phase = "none";
  webview.bind("phase", (p: string) => {
    phase = p;
    if (p === "handler") {
      webview.setRequestHandler((req: WebviewRequest) => {
        const path = new URL(req.url).pathname;
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
    }
    return phase;
  });
  pageRun(
    webview,
    `const status = async (url, init) => { try { const r = await fetch(url, init); return r.status; } catch (e) { return "error:" + e.name; } };
    const r = {};
    r.noHandlerMain = await status("/anything");
    // The frames origin from the page's origin is cross-origin: no-cors reads an opaque answer.
    r.noHandlerFrames = await new Promise((res) => { const f = document.createElement("iframe"); f.src = ${JSON.stringify(webview.framesOrigin)} + "/x"; f.onload = () => res("loaded"); document.body.appendChild(f); });
    await window.phase("handler");
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
    window.report(r);`,
  );
  finish();
}

if (scenario === "streaming") {
  // W2.5 from the UI thread: the Webview methods.
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  webview.setRequestHandler((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/stream") {
      webview.beginResponse(req.id, { status: 201, headers: [["Content-Type", "text/plain"], ["X-Multi", "a"], ["X-Multi", "b"]] });
      report.duplicateBegin = codeOf(() => webview.beginResponse(req.id));
      webview.writeResponseChunk(req.id, "one,");
      webview.writeResponseChunk(req.id, new TextEncoder().encode("two,"));
      webview.writeResponseChunk(req.id, new TextEncoder().encode("three").buffer);
      report.emptyChunk = codeOf(() => webview.writeResponseChunk(req.id, new Uint8Array(0)));
      webview.endResponse(req.id);
      report.secondEnd = codeOf(() => webview.endResponse(req.id));
      report.chunkAfterEnd = codeOf(() => webview.writeResponseChunk(req.id, "late"));
      return;
    }
    if (path === "/answered-then-begun") {
      webview.completeRequest(req.id, { body: "completed" });
      report.beginAfterComplete = codeOf(() => webview.beginResponse(req.id, { status: 500 }));
      report.chunkAfterComplete = codeOf(() => webview.writeResponseChunk(req.id, "dropped"));
      return;
    }
    if (path === "/end-unbegun") {
      report.endUnbegun = codeOf(() => webview.endResponse(req.id));
      webview.completeRequest(req.id, { body: "still answerable" });
      return;
    }
    if (path === "/bad-head") {
      report.badHeadHeader = codeOf(() => webview.beginResponse(req.id, { headers: { "X-A": "a\r\nb" } }));
      report.badHeadStatus = codeOf(() => webview.beginResponse(req.id, { status: 99 }));
      webview.completeRequest(req.id, { body: "open after refusal" });
      return;
    }
    return { status: 404 };
  });
  pageRun(
    webview,
    `const read = async (p) => { const r = await fetch(p); return { status: r.status, multi: r.headers.get("x-multi"), body: await r.text() }; };
    window.report({ stream: await read("/stream"), answered: await read("/answered-then-begun"), unbegun: await read("/end-unbegun"), badHead: await read("/bad-head") });`,
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

if (scenario === "drops") {
  // W2.6: a real file drop, driven through the DevTools protocol, reaches the
  // handler with its real path; an HTML drag and drop inside the page still
  // reaches the page's own drop listener while the handler is set.
  const webview = new Webview(false, { width: 400, height: 300, hint: SizeHint.NONE });
  webview.title = tag;
  const file = join(process.env.WEBVIEW2_USER_DATA_FOLDER!, "dropped ü.txt");
  await Bun.write(file, "drop");
  const engine = engineOf(webview)!;
  const drag = (data: object, x = 60, y = 60) => {
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      const code = engine.callDevToolsProtocolMethod("Input.dispatchDragEvent", JSON.stringify({ type, x, y, data }));
      if (code !== 0) return code;
    }
    return 0;
  };
  report.allowFalse = codeOf(() => webview.setAllowExternalDrop(false));
  report.allowTrue = codeOf(() => webview.setAllowExternalDrop(true));
  const handled: string[][] = [];
  webview.setFileDropHandler((paths) => {
    handled.push(paths);
    // An in-page drag of text, no files: the page's own listener gets it, the handler does not.
    native.scheduleTimeout(100, () => {
      report.textDrag = drag({ items: [{ mimeType: "text/plain", data: "in-page text" }], dragOperationsMask: 1 });
    });
  });
  const pageDrops: { text: string; files: number; defaultPrevented: boolean; handlerSet: boolean }[] = [];
  webview.bind("pageDrop", (info: (typeof pageDrops)[number]) => {
    pageDrops.push(info);
    if (info.files === 0) native.scheduleTimeout(300, () => native.quitLoop());
  });
  webview.bind("ready", () => {
    report.fileDrag = drag({ items: [], files: [file], dragOperationsMask: 1 });
  });
  webview.setHTML(`<!doctype html><body style="margin:0;height:100vh"><div draggable="true" id="source">drag me</div><script>
    addEventListener("dragover", (e) => e.preventDefault());
    addEventListener("drop", (e) => {
      const defaultPrevented = e.defaultPrevented;
      e.preventDefault();
      window.pageDrop({ text: e.dataTransfer.getData("text/plain"), files: e.dataTransfer.files.length, defaultPrevented, handlerSet: window.__webview_file_drop_enabled__ === true });
    });
    window.ready();
  </script></body>`);
  webview.run();
  report.handled = handled;
  report.pageDrops = pageDrops;
  report.file = file;
  finish();
}

if (scenario === "teardown-open-requests") {
  // W2.9: destroying a webview with requests open (one never answered, one
  // streamed and never ended) releases them unanswered; run() returns; late
  // answers are refused with -3.
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  const handle = webview.unsafeHandle!;
  const open: bigint[] = [];
  webview.setRequestHandler((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/pending") open.push(req.id);
    if (path === "/streaming") {
      webview.beginResponse(req.id, { headers: { "Content-Type": "text/plain" } });
      webview.writeResponseChunk(req.id, "partial");
      open.push(req.id);
    }
    if (open.length === 2) native.scheduleTimeout(200, () => webview.destroy());
  });
  webview.setHTML(`<!doctype html><script>fetch(${JSON.stringify(webview.assetOrigin)} + "/pending").catch(() => {}); fetch(${JSON.stringify(webview.assetOrigin)} + "/streaming").catch(() => {});</script>`);
  webview.run();
  report.runReturned = true;
  report.openAtDestroy = open.length;
  report.late = open.map((id) => ({
    complete: codeOf(() => completeWebviewRequest(handle, id, { body: "late" })),
    chunk: codeOf(() => webview.writeResponseChunk(id, "late")),
  }));
  finish();
}

if (scenario === "teardown-worker-race") {
  // W2.9: a worker answers and streams as fast as it can while the UI thread
  // destroys the webview. Every call before the destroy is accepted, every
  // call after it is refused with -3, and nothing crashes.
  const webview = new Webview(false, { width: 300, height: 200, hint: SizeHint.NONE });
  const handle = webview.unsafeHandle!;
  const worker = new Worker(new URL("./race-worker.ts", import.meta.url).href);
  await new Promise<void>((resolve) => (worker.onmessage = () => resolve()));
  let requests = 0;
  webview.setRequestHandler((req) => {
    requests++;
    worker.postMessage({ handle, id: req.id, stream: new URL(req.url).pathname === "/stream" });
    if (requests === 2) native.scheduleTimeout(300, () => webview.destroy());
  });
  webview.setHTML(`<!doctype html><script>fetch(${JSON.stringify(webview.assetOrigin)} + "/stream").catch(() => {}); fetch(${JSON.stringify(webview.assetOrigin)} + "/complete").catch(() => {});</script>`);
  webview.run();
  report.runReturned = true;
  worker.postMessage({ stop: true });
  report.worker = await new Promise((resolve) => (worker.onmessage = (e) => resolve(e.data)));
  worker.terminate();
  finish();
}

throw new Error(`unknown scenario ${scenario}`);
