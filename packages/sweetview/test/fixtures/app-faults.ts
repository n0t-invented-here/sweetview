// Three faults of an application's callbacks in createApp that once took more than their own call
// down (review 2, item 9). Run by src/app.test.ts in a process of its own, which reads its stderr.
//
//   - A UI-thread method (deferred or not) that throws a value that cannot be turned into text: its
//     call is rejected, and the other calls of a deferred batch are still answered.
//   - An onEvent listener that throws: the other listeners and the page still get that event and
//     the next, and the reply behind them is still delivered.
//   - A worker that crashes: its failure is printed once.
//
// Prints `RESULT <json>`. No input is injected.

import { pumpEvents } from "@n1h/sweetview-native";
import { createApp } from "../../src/index";

// Values that cannot be turned into text the usual way: `instanceof` throws for the first, and
// `String()` for the second.
const unreadable = () =>
  new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("getPrototypeOf trap");
      },
    },
  );
const noPrototype = () => Object.create(null) as object;

const page = `<!doctype html><title>app faults</title><script>
  const rpc = window.__sweetview_rpc;
  const seen = { events: [] };
  window.__sweetview_emit = (name, payload) => seen.events.push(name + " " + payload);
  const note = (name, p) => p.then((v) => (seen[name] = "resolved: " + v), (e) => (seen[name] = "rejected: " + (e && e.message)));
  // Not awaited one by one: the deferred calls are queued together and answered in one batch.
  // What is seen is sent a moment after the worker's reply, whether or not every call was answered.
  note("deferredUnreadable", rpc("deferred.unreadable", null));
  note("deferredOk", rpc("deferred.ok", null));
  note("deferredNoPrototype", rpc("deferred.noPrototype", null));
  note("uiUnreadable", rpc("ui.unreadable", null));
  const sent = () => {
    rpc("seen", seen);
    // Then the crash: the worker's own crash frame and Worker.onerror both see it.
    rpc("crash", null);
  };
  note("ticks", rpc("ticks", null)).then(() => setTimeout(sent, 1000));
  setTimeout(() => seen.ticks === undefined && sent(), 10000);
  rpc("__sweetview.ready", null);
</script>`;

let seen: unknown;
const tapped: string[] = [];
const app = await createApp({
  title: `sweetview app faults ${process.pid}`,
  noActivate: true,
  assets: { "index.html": new TextEncoder().encode(page) },
  worker: new URL("./app-faults.worker.ts", import.meta.url),
  uiMethods: {
    "ui.unreadable": () => {
      throw unreadable();
    },
    seen: (value: unknown) => void (seen = value),
  },
  deferredUiMethods: {
    "deferred.unreadable": () => {
      throw unreadable();
    },
    "deferred.ok": () => "ok",
    "deferred.noPrototype": () => {
      throw noPrototype();
    },
  },
});
app.onEvent(() => {
  throw new Error("onEvent listener");
});
app.onEvent((event) => void tapped.push(`${event.name} ${String(event.payload)}`));

async function pumpUntil(done: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    pumpEvents();
    await Bun.sleep(5);
  }
}

await pumpUntil(() => seen !== undefined, 30_000);
await pumpUntil(() => false, 1500);
app.dispose();
console.log("RESULT " + JSON.stringify({ seen: seen ?? null, tapped }));
process.exit(0);
