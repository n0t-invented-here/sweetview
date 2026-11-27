// Replacing, clearing and destroying from inside the request handler and the
// file drop handler, against a real webview. One scenario per process (the
// name is argv[2]); prints one line `RESULT <json>`. Run by
// src/request-handler.test.ts in a child process with its own WebView2
// profile, so a teardown that hangs fails the test instead of the run.
//
// Brought over from the bindings' test/fixtures/live-callback-teardown.ts
// (W2.7). What changed: the old fixture called the file drop handler through
// its native function pointer from inside a binding; here every drop is a
// real one, driven through the DevTools protocol with real files, so the
// handler runs where WebView2 delivers it. The counts of `JSCallback`s waiting
// to be closed (`pendingCallbackCloses`) have no counterpart: the binding
// holds a function by reference and releases it when nothing calls it.

import { join } from "node:path";
import { engineOf, Webview, WebviewError } from "../../src/webview";
import { native, report, watchdog } from "./kit";

watchdog(40_000);
const scenario = process.argv[2];
const webview = new Webview(false, { width: 400, height: 300, hint: 0 });
if (!webview.unsafeHandle) throw new Error("the webview has no handle");
report.scenario = scenario;

// What fn throws: a WebviewError's code, or a description.
function codeOf(fn: () => void): number | string {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return e instanceof WebviewError ? e.code : String(e);
  }
}

// Every API a handler might reach for once the webview is destroyed.
function afterDestroyCodes() {
  return {
    completeRequest: codeOf(() => webview.completeRequest(1n, {})),
    setRequestHandler: codeOf(() => webview.setRequestHandler(null)),
    setFileDropHandler: codeOf(() => webview.setFileDropHandler(null)),
  };
}

// A page that fetches each path in order, reports the statuses and bodies,
// and then calls `done` (unless the webview is gone by then).
function pageFetching(paths: string[]) {
  return `<!doctype html><html><body><script>
(async () => {
  const r = [];
  for (const p of ${JSON.stringify(paths)}) {
    try {
      const resp = await fetch(p);
      r.push({ path: p, status: resp.status, body: await resp.text() });
    } catch (e) {
      r.push({ path: p, error: String(e) });
    }
  }
  window.done(JSON.stringify(r));
})();
</script></body></html>`;
}

if (scenario === "request-replace-clear") {
  // /a: handler A replaces itself with B and answers. /b: B clears itself
  // and answers. /c: no handler, so 404.
  const html = pageFetching(["/a", "/b", "/c"]);
  const calls: string[] = [];
  const handlerB = (req: { url: string }) => {
    const path = new URL(req.url).pathname;
    calls.push(`B${path}`);
    if (path === "/b") {
      webview.setRequestHandler(null);
      return { body: "from-B" };
    }
    return { status: 500 };
  };
  webview.setRequestHandler((req) => {
    const path = new URL(req.url).pathname;
    calls.push(`A${path}`);
    if (path === "/index.html") return { headers: { "Content-Type": "text/html; charset=utf-8" }, body: html };
    if (path === "/a") {
      webview.setRequestHandler(handlerB);
      return { body: "from-A" };
    }
    return { status: 500 };
  });
  webview.bind("done", (json: string) => {
    report.page = JSON.parse(json);
    report.calls = calls;
    webview.destroy();
  });
  webview.navigate(`${webview.assetOrigin}/index.html`);
  webview.run();
  report.runReturned = true;
} else if (scenario === "request-destroy") {
  // /destroy: the handler destroys the webview from inside
  // WebResourceRequested. run() must return and the process exit.
  const html = pageFetching(["/destroy", "/after"]);
  let destroyed = false;
  let callsAfterDestroy = 0;
  webview.setRequestHandler((req) => {
    if (destroyed) {
      callsAfterDestroy++;
      return { status: 500 };
    }
    const path = new URL(req.url).pathname;
    if (path === "/index.html") return { headers: { "Content-Type": "text/html; charset=utf-8" }, body: html };
    if (path === "/destroy") {
      destroyed = true;
      webview.destroy();
      report.destroyedInsideCall = true;
      report.insideCall = afterDestroyCodes();
      // Ignored: the webview is gone, and destroying it releases the request unanswered.
      return { body: "too late" };
    }
    return { status: 404 };
  });
  webview.bind("done", () => {
    report.pageFinished = true; // never: the webview is gone first
    webview.destroy();
  });
  webview.navigate(`${webview.assetOrigin}/index.html`);
  webview.run();
  report.runReturned = true;
  report.callsAfterDestroy = callsAfterDestroy;
  report.afterRun = afterDestroyCodes();
} else if (scenario === "drop-replace-clear-destroy") {
  // Real drops, one after another: A replaces itself with B, B clears
  // itself, a drop with no handler goes to the page, C destroys the webview.
  const folder = process.env.WEBVIEW2_USER_DATA_FOLDER!;
  const files: Record<string, string> = {};
  for (const name of ["one", "two", "three", "four"]) {
    files[name] = join(folder, `${name}.txt`);
    await Bun.write(files[name]!, name);
  }
  const engine = engineOf(webview)!;
  const drop = (name: string) => {
    const data = { items: [], files: [files[name]], dragOperationsMask: 1 };
    let code = 0;
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      code ||= engine.callDevToolsProtocolMethod("Input.dispatchDragEvent", JSON.stringify({ type, x: 40, y: 40, data }));
    }
    return code;
  };
  const base = (paths: string[]) => paths.map((p) => p.split(/[\\/]/).pop()!.replace(".txt", "")).join(",");
  const drops: string[] = [];
  const next = (step: () => void) => native.scheduleTimeout(150, step);

  const handlerC = (paths: string[]) => {
    drops.push(`C:${base(paths)}`);
    report.fourthCalled = true;
    webview.destroy();
    report.insideCall = afterDestroyCodes();
    // Destroyed: the DevTools call is refused and no further drop arrives.
    report.dropAfterDestroy = engine.callDevToolsProtocolMethod("Input.dispatchDragEvent", "{}");
  };
  const handlerB = (paths: string[]) => {
    drops.push(`B:${base(paths)}`);
    report.secondCalled = true;
    webview.setFileDropHandler(null);
    // No handler: the drop goes to the page, whose listener reports it.
    next(() => drop("three"));
  };
  webview.setFileDropHandler((paths) => {
    drops.push(`A:${base(paths)}`);
    report.firstCalled = true;
    webview.setFileDropHandler(handlerB);
    next(() => drop("two"));
  });
  webview.bind("pageDrop", (names: string[]) => {
    drops.push(`page:${names.join(",")}`);
    report.thirdCalled = true;
    webview.setFileDropHandler(handlerC);
    next(() => drop("four"));
  });
  webview.bind("ready", () => {
    report.firstDrop = drop("one");
  });
  webview.setHTML(`<!doctype html><html><body style="margin:0;height:100vh">drop here<script>
    addEventListener("dragover", (e) => e.preventDefault());
    addEventListener("drop", (e) => {
      if (window.__webview_file_drop_enabled__) return;
      e.preventDefault();
      window.pageDrop([...e.dataTransfer.files].map((f) => f.name.replace(".txt", "")));
    });
    window.ready();
  </script></body></html>`);
  webview.run();
  report.drops = drops;
  report.runReturned = true;
  report.afterRun = afterDestroyCodes();
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

console.log("RESULT " + JSON.stringify(report));
process.exit(0);
