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
// `bun webview-errors.ts none`: no listener, for the lines printed with none (review 4, C1).
const listening = process.argv[2] !== "none";
// `bun webview-errors.ts throwing`: the listener records each fault, then throws (review 5, E1).
const throwing = process.argv[2] === "throwing";
if (listening) {
  onCallbackError((error, source) => {
    told.push(`${source.kind}${source.name ? ` (${source.name})` : ""}: ${messageOf(error)}${error === shared ? " [the thrown object]" : ""}`);
    if (throwing) throw new Error("listener boom");
  });
}

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
// A thrown Error whose `message` getter adds a listener the first time it is read (review 3,
// item 3). The page's reply reads `message`; the listeners are taken before it is, so the added
// listener does not hear the fault it was added during.
const lateTold: string[] = [];
let lateAdded = false;
const addsListener = new Error("placeholder");
Object.defineProperty(addsListener, "message", {
  get() {
    if (!lateAdded && listening) {
      lateAdded = true;
      onCallbackError((_error, source) => {
        if (source.name === "bindAddsListener") lateTold.push(`${source.kind} (${source.name})`);
      });
    }
    return "adds a listener";
  },
});
webview.bind("bindAddsListener", () => {
  throw addsListener;
});
// A returned value whose `then` cannot be read, and a Promise whose `then` throws (review 3,
// item 1): as on the main branch, each fails the call and the page's call is rejected.
webview.bind("bindThenGetter", () => ({
  get then() {
    throw new Error("then getter");
  },
}));
webview.bind("bindThenThrows", () => {
  const promise = Promise.resolve(1);
  promise.then = () => {
    throw new Error("then throws");
  };
  return promise;
});
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
  // A returned value whose prototype cannot be read (review 2, P1; review 3, item 1): the check
  // for a Promise throws, which fails the call: answered 500, and nothing reaches the binding's
  // own catch, where the main branch let it escape.
  if (request.url.endsWith("/proxy")) {
    return new Proxy({}, {
      getPrototypeOf() {
        throw new Error("returned getPrototypeOf trap");
      },
    }) as never;
  }
  // A Promise whose `then` getter throws, and one whose `then` throws (review 3, item 1): 500.
  if (request.url.endsWith("/promise-then-getter")) {
    const promise = Promise.resolve({ status: 204 });
    Object.defineProperty(promise, "then", {
      get() {
        throw new Error("request then getter");
      },
    });
    return promise;
  }
  if (request.url.endsWith("/promise-then-throws")) {
    const promise = Promise.resolve({ status: 204 });
    promise.then = () => {
      throw new Error("request then throws");
    };
    return promise;
  }
  // A thenable that is no Promise (review 3): as on the main branch it is not awaited; it is the
  // response itself, which names no status: 200.
  if (request.url.endsWith("/thenable")) {
    return { then: (resolve: (r: unknown) => void) => resolve({ status: 201 }) } as never;
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
      try { await bindAddsListener(); seen.bindAddsListener = "resolved"; } catch (e) { seen.bindAddsListener = "rejected: " + e; }
      try { await bindThenGetter(); seen.bindThenGetter = "resolved"; } catch (e) { seen.bindThenGetter = "rejected"; }
      try { await bindThenThrows(); seen.bindThenThrows = "resolved"; } catch (e) { seen.bindThenThrows = "rejected"; }
      // A raw binding that throws leaves the page's call unanswered (docs/native.md): no answer in 500 ms.
      seen.rawThrows = await Promise.race([rawThrows().then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("unanswered"), 500))]);
      save();
      load();
      seen.throws = (await fetch("/throws")).status;
      seen.rejects = (await fetch("/rejects")).status;
      seen.proxy = (await fetch("/proxy")).status;
      seen.promiseThenGetter = (await fetch("/promise-then-getter")).status;
      seen.promiseThenThrows = (await fetch("/promise-then-throws")).status;
      seen.thenable = (await fetch("/thenable")).status;
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
await pumpUntil(() => dropped && (!listening || told.some((t) => t.startsWith("webview.setFileDropHandler"))), 10_000);
await pumpUntil(() => false, 200);

report.page = page;
report.told = [...told].sort();
report.lateTold = lateTold;
webview.destroy();
finish();
