// onCallbackError and the callback boundaries of the raw webview class (review F6, N3): a bound
// function that throws or whose promise rejects, a raw binding that throws, a request handler that
// throws or whose promise rejects, and a file drop handler that throws, each reported once with its
// kind while the page or the request still gets its failure. Run by src/callbacks.test.ts in a
// process of its own; prints `RESULT <json>`. The drop is the DevTools protocol's, not OS input.

import { join } from "node:path";
import { onCallbackError } from "../../src/callback-errors";
import { engineOf, SizeHint, Webview } from "../../src/webview";
import { finish, native, report, watchdog } from "./kit";

watchdog(40_000);
const told: string[] = [];
onCallbackError((error, source) => void told.push(`${source.kind}${source.name ? ` (${source.name})` : ""}: ${error.message}`));

const webview = new Webview(false, { width: 360, height: 240, hint: SizeHint.NONE });
webview.title = `sweetview webview-errors ${process.pid}`;
const engine = engineOf(webview)!;
const origin = webview.assetOrigin;

webview.bind("bindThrows", () => {
  throw new Error("bind throws");
});
webview.bind("bindRejects", () => Promise.reject(new Error("bind rejects")));
webview.bindRaw("rawThrows", () => {
  throw new Error("raw throws");
});
webview.setRequestHandler((request) => {
  if (request.url.endsWith("/throws")) throw new Error("request throws");
  if (request.url.endsWith("/rejects")) return Promise.reject(new Error("request rejects"));
  return { status: 404 };
});
let dropped = false;
webview.setFileDropHandler(() => {
  dropped = true;
  throw new Error("drop throws");
});

let page: unknown;
webview.bind("done", (seen: unknown) => void (page = seen));
webview.setAsset(
  "index.html",
  "text/html; charset=utf-8",
  `<!doctype html><body style="margin:0;height:100vh"><script>
    addEventListener("dragover", (e) => e.preventDefault()); addEventListener("drop", (e) => e.preventDefault());
    (async () => {
      const seen = {};
      try { await bindThrows(); seen.bindThrows = "resolved"; } catch (e) { seen.bindThrows = "rejected"; }
      try { await bindRejects(); seen.bindRejects = "resolved"; } catch (e) { seen.bindRejects = "rejected"; }
      rawThrows();
      seen.throws = (await fetch("/throws")).status;
      seen.rejects = (await fetch("/rejects")).status;
      await done(seen);
    })();
  </script></body>`,
);
webview.navigate(`${origin}/index.html`);

async function pumpUntil(done: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    native.pumpEvents();
    await Bun.sleep(5);
  }
}
await pumpUntil(() => page !== undefined, 20_000);
const file = join(process.env.WEBVIEW2_USER_DATA_FOLDER!, "dropped.txt");
await Bun.write(file, "dropped");
for (const type of ["dragEnter", "dragOver", "drop"]) {
  engine.callDevToolsProtocolMethod("Input.dispatchDragEvent", JSON.stringify({ type, x: 40, y: 40, data: { items: [], files: [file], dragOperationsMask: 1 } }));
}
await pumpUntil(() => dropped && told.some((t) => t.startsWith("webview.setFileDropHandler")), 10_000);
await pumpUntil(() => false, 200);

report.page = page;
report.told = [...told].sort();
webview.destroy();
finish();
