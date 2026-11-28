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
// The message is read with care: one of the values below is an Error whose message getter throws.
const messageOf = (error: Error) => {
  try {
    return String(error.message);
  } catch {
    return "(its message throws)";
  }
};
// Two raw bindings throw the same error (review 2, item 5): each arrives with its own name, as that object.
const shared = new Error("shared");
onCallbackError((error, source) => void told.push(`${source.kind}${source.name ? ` (${source.name})` : ""}: ${messageOf(error)}${error === shared ? " [the thrown object]" : ""}`));

const webview = new Webview(false, { width: 360, height: 240, hint: SizeHint.NONE });
webview.title = `sweetview webview-errors ${process.pid}`;
const engine = engineOf(webview)!;
const origin = webview.assetOrigin;

webview.bind("bindThrows", () => {
  throw new Error("bind throws");
});
webview.bind("bindRejects", () => Promise.reject(new Error("bind rejects")));
// Values whose inspection throws (review 2, item 1): the page's call must still be rejected.
webview.bind("bindProxy", () => {
  throw new Proxy({}, {
    getPrototypeOf() {
      throw new Error("getPrototypeOf trap");
    },
  });
});
const badMessage = new Error("unreadable");
Object.defineProperty(badMessage, "message", {
  get() {
    throw new Error("message getter");
  },
});
webview.bind("bindBadMessage", () => Promise.reject(badMessage));
webview.bindRaw("rawThrows", () => {
  throw new Error("raw throws");
});
webview.bindRaw("save", () => {
  throw shared;
});
webview.bindRaw("load", () => {
  throw shared;
});
webview.setRequestHandler((request) => {
  if (request.url.endsWith("/throws")) throw new Error("request throws");
  if (request.url.endsWith("/rejects")) return Promise.reject(new Error("request rejects"));
  // A returned value whose prototype cannot be read (review 2, P1): it is an empty response, and
  // inspecting it stays in TypeScript: answered 200, nothing reaches the binding's own catch.
  if (request.url.endsWith("/proxy")) {
    return new Proxy({}, {
      getPrototypeOf() {
        throw new Error("returned getPrototypeOf trap");
      },
    }) as never;
  }
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
      try { await bindProxy(); seen.bindProxy = "resolved"; } catch (e) { seen.bindProxy = "rejected"; }
      try { await bindBadMessage(); seen.bindBadMessage = "resolved"; } catch (e) { seen.bindBadMessage = "rejected"; }
      rawThrows();
      save();
      load();
      seen.throws = (await fetch("/throws")).status;
      seen.rejects = (await fetch("/rejects")).status;
      seen.proxy = (await fetch("/proxy")).status;
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
