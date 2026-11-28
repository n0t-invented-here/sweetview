// Three faults of an application's callbacks in createApp that once took more than their own call
// down (review 2, item 9). Run by src/app.test.ts in a process of its own, which reads its stderr.
//
//   - A UI-thread method (deferred or not) that throws a value that cannot be turned into text: its
//     call is rejected, and the other calls of a deferred batch are still answered.
//   - An onEvent listener that throws: the other listeners and the page still get that event and
//     the next, and the reply behind them is still delivered.
//   - A worker that crashes: its failure is printed once.
//
//   bun app-faults.ts           no onCallbackError listener: what stderr shows
//   bun app-faults.ts listen    one listener: what it is told, and what stderr still shows
//   bun app-faults.ts crash-event   one listener; the worker emits an event and then crashes, and
//                                   Worker.onerror is seen before the native drain runs (nothing is
//                                   pumped meanwhile): the cleanup after the failure delivers the event
//
// Prints `RESULT <json>`. No input is injected.

import { onCallbackError, pumpEvents } from "@n1h/sweetview-native";
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
  note("workerUnreadable", rpc("throws.unreadable", null));
  note("workerNoPrototype", rpc("throws.noPrototype", null));
  const sent = () => {
    rpc("seen", seen);
    // Then the crash: the worker's own crash frame and Worker.onerror both see it.
    rpc("crash", null);
  };
  // tock after the ticks' reply: its one event has a delivery of its own, in which two listeners throw.
  note("ticks", rpc("ticks", null))
    .then(() => note("tock", rpc("tock", null)))
    .then(() => setTimeout(sent, 1000));
  setTimeout(() => seen.ticks === undefined && sent(), 10000);
  rpc("__sweetview.ready", null);
</script>`;

let seen: unknown;
const tapped: string[] = [];
const told: string[] = [];
const mode = process.argv[2] ?? "";
const crashEvent = mode === "crash-event";
// An AggregateError is told with the messages of the errors it holds.
const inner = (error: Error) => (error instanceof AggregateError ? ` [${error.errors.map((e: Error) => e.message).join(", ")}]` : "");
if (mode === "listen" || crashEvent) onCallbackError((error, source) => void told.push(`${source.kind}: ${error.message}${inner(error)}`));
const app = await createApp({
  title: `sweetview app faults ${process.pid}`,
  noActivate: true,
  assets: { "index.html": new TextEncoder().encode(crashEvent ? `<!doctype html><script>window.__sweetview_rpc("__sweetview.ready", null)</script>` : page) },
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
// Throws for the first tick only, so what is printed or told is the same however the ticks are
// drained; for tock's event, as the listener after the next does.
app.onEvent((event) => {
  if (event.payload === 1 || event.payload === 99 || event.payload === 7) throw new Error(`onEvent listener ${String(event.payload)}`);
});
app.onEvent((event) => void tapped.push(`${event.name} ${String(event.payload)}`));
app.onEvent((event) => {
  if (event.payload === 7) throw new Error("another onEvent listener 7");
});

async function pumpUntil(done: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    pumpEvents();
    await Bun.sleep(5);
  }
}

if (crashEvent) {
  await pumpUntil(() => false, 2000);
  app.notify("crash.afterEvent" as never, null as never);
  // Bun's own loop runs, the native one does not: Worker.onerror comes first, and the cleanup
  // after the failure drains the ring, the event included.
  await Bun.sleep(1500);
  await pumpUntil(() => false, 500);
} else {
  await pumpUntil(() => seen !== undefined, 30_000);
  await pumpUntil(() => false, 1500);
}
app.dispose();
console.log("RESULT " + JSON.stringify({ seen: seen ?? null, tapped, told }));
process.exit(0);
