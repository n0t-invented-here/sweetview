// The thread and the lifetime of onCallbackError's sink in the binding (review F1, F8, N4). Run by
// src/callbacks.test.ts in a process of its own, which reads this process's stderr and exit code.
// No window is shown and no input is injected.
//
//   bun callback-sink.ts worker-first    a Worker calls onCallbackError before this thread loads
//                                        the binding; then this thread makes a Window
//   bun callback-sink.ts worker-raw      a Worker calls the binding's setCallbackErrorSink itself
//   bun callback-sink.ts worker-raw-first  a Worker loads the binding first, sets a sink straight
//                                        through it and ends; the environment hook releases it
//   bun callback-sink.ts missing-export  the binding has no setCallbackErrorSink (an older build)
//   bun callback-sink.ts after-release   a listener set, then releaseAll(); the binding's own catch
//   bun callback-sink.ts at-end          a listener set, and nothing else made; the process ends
//
// Prints `RESULT <json>` (at-end prints nothing and only ends).

const mode = process.argv[2];
const result: Record<string, unknown> = {};
const errorOf = async (run: () => unknown): Promise<string | null> => {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

if (mode === "worker-raw-first") {
  // A Worker loads the raw binding before this thread does, so it is the binding's UI thread, sets
  // a sink straight through the binding (no TypeScript of the package's), and ends. The sink is
  // released by the environment's cleanup hook when the worker's environment ends; nothing else
  // releases it on that path (review 2, item 6).
  const source = `const { binding } = await import(${JSON.stringify(new URL("../../src/binding.ts", import.meta.url).href)});
    try { binding().setCallbackErrorSink(() => {}); postMessage("set"); } catch (err) { postMessage(String(err && err.message)); }`;
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "application/typescript" })));
  result.worker = await new Promise<string>((resolve) => {
    worker.onmessage = (event) => resolve(String(event.data));
    worker.onerror = (event) => resolve(`worker error: ${event.message}`);
  });
  await new Promise<void>((resolve) => {
    worker.addEventListener("close", () => resolve());
    worker.terminate();
  });
  await Bun.sleep(200);
}

if (mode === "worker-first" || mode === "worker-raw") {
  const source =
    mode === "worker-first"
      ? `const { onCallbackError } = await import(${JSON.stringify(new URL("../../src/callback-errors.ts", import.meta.url).href)});
         try { onCallbackError(() => {}); postMessage("registered"); } catch (err) { postMessage(String(err && err.message)); }`
      : `const { binding } = await import(${JSON.stringify(new URL("../../src/binding.ts", import.meta.url).href)});
         try { binding().setCallbackErrorSink(() => {}); postMessage("set"); } catch (err) { postMessage(String(err && err.message)); }`;
  const url = URL.createObjectURL(new Blob([source], { type: "application/typescript" }));
  if (mode === "worker-raw") {
    // This thread loads the binding first, so it is the UI thread; the worker is not.
    (await import("../../src/binding")).binding();
  }
  const worker = new Worker(url);
  result.worker = await new Promise<string>((resolve) => {
    worker.onmessage = (event) => resolve(String(event.data));
    worker.onerror = (event) => resolve(`worker error: ${event.message}`);
  });
  worker.terminate();
  if (mode === "worker-first") {
    const { Window } = await import("../../src/window");
    result.windowOnThisThread = await errorOf(() => new Window({ title: "callback-sink" }).dispose());
  }
}

if (mode === "missing-export") {
  const { binding } = await import("../../src/binding");
  const native = binding() as unknown as Record<string, unknown>;
  delete native.setCallbackErrorSink;
  const { onCallbackError } = await import("../../src/callback-errors");
  result.registration = await errorOf(() => onCallbackError(() => {}));
}

if (mode === "after-release") {
  const { binding } = await import("../../src/binding");
  const { onCallbackError } = await import("../../src/callback-errors");
  const { releaseAll } = await import("../../src/lifetime");
  const told: string[] = [];
  onCallbackError((error, source) => void told.push(`${source.kind} (${source.name}): ${error.message}`));
  releaseAll();
  const native = binding();
  const interval = native.scheduleInterval(5, () => {
    native.cancelTimeout(interval);
    throw new Error("interval after release");
  });
  const deadline = Date.now() + 3000;
  while (told.length === 0 && Date.now() < deadline) {
    native.pumpEvents();
    await Bun.sleep(5);
  }
  result.told = told;
}

if (mode === "values" || mode === "values-listen") {
  // Every kind of value thrown from a callback that reaches the binding's own catch (a raw
  // binding's timeout: no TypeScript catch is in the way), one at a time, with no listener and
  // with one (review 3, item 2 and Q1). After each, the pump returned normally and the next call
  // into the binding works: nothing is left pending on the environment.
  const { binding } = await import("../../src/binding");
  const native = binding();
  const values: [string, () => unknown][] = [
    ["string", () => "disconnected"],
    ["number", () => 42],
    ["null", () => null],
    ["undefined", () => undefined],
    ["symbol", () => Symbol("thrown")],
    ["no prototype", () => Object.create(null)],
    ["toString throws", () => ({ toString() { throw new Error("toString throws"); } })],
    ["plain object", () => ({ a: 1 })],
    ["error", () => new Error("boom")],
    ["error whose cause is itself", () => { const e = new Error("loop") as Error & { cause?: unknown }; e.cause = e; return e; }],
    ["error whose message throws", () => Object.defineProperty(new Error("hidden"), "message", { get() { throw new Error("message getter"); } })],
  ];
  const told: { name?: string; kind: string; message: string; isThrown: boolean; causeIsThrown: boolean }[] = [];
  let off = () => {};
  if (mode === "values-listen") {
    const { onCallbackError } = await import("../../src/callback-errors");
    off = onCallbackError((error, source) => {
      const thrown = current;
      let message: string;
      try {
        message = error.message;
      } catch {
        message = "(its message throws)";
      }
      told.push({ name: source.name, kind: source.kind, message, isThrown: error === thrown, causeIsThrown: error.cause === thrown });
    });
  }
  let current: unknown;
  const after: string[] = [];
  for (const [label, make] of values) {
    let ran = false;
    native.scheduleTimeout(1, () => {
      ran = true;
      current = make();
      throw current;
    });
    let outcome = "returned";
    try {
      for (let i = 0; i < 400 && !ran; i++) {
        native.pumpEvents();
        await Bun.sleep(5);
      }
      native.pumpEvents();
    } catch (err) {
      outcome = `the pump threw ${String(err)}`;
    }
    try {
      native.isLoopBlocking();
    } catch (err) {
      outcome += `; the next call threw ${String(err)}`;
    }
    after.push(`${label}: ${ran ? "ran" : "did not run"}, ${outcome}`);
  }
  off();
  result.after = after;
  result.told = told;
}

if (mode === "patched-globals") {
  // The binding loads; then the application patches what the binding's guard uses; then it makes
  // its first callbacks (follow-up 3). The guard holds what the globals were at load.
  const { binding } = await import("../../src/binding");
  const { onCallbackError } = await import("../../src/callback-errors");
  const native = binding();
  const saved = { apply: Reflect.apply, create: Object.create, text: globalThis.String };
  const told: string[] = [];
  let ran = 0;
  const throwFromTimeout = async (message: string) => {
    const target = ran + 1;
    native.scheduleTimeout(1, () => {
      ran++;
      throw new Error(message);
    });
    for (let i = 0; i < 400 && ran < target; i++) {
      native.pumpEvents();
      await Bun.sleep(5);
    }
    native.pumpEvents();
  };
  Reflect.apply = () => {
    throw new Error("patched Reflect.apply");
  };
  Object.create = () => {
    throw new Error("patched Object.create");
  };
  globalThis.String = (() => "patched String") as unknown as StringConstructor;
  await throwFromTimeout("first"); // no listener: the line is napi's text of the guard's stand-in
  const off = onCallbackError((error, source) => void told.push(`${source.name}: ${error.message}`));
  await throwFromTimeout("second"); // with one: the value itself
  off();
  Object.assign(Reflect, { apply: saved.apply });
  Object.create = saved.create;
  globalThis.String = saved.text;
  result.ran = ran;
  result.told = told;
}

if (mode === "late-listener") {
  // No listener when the callback throws; reading the thrown value registers one (review 4, C5).
  // The listeners told about a fault are those set when it was thrown: this one hears nothing.
  const { binding } = await import("../../src/binding");
  const { onCallbackError } = await import("../../src/callback-errors");
  const native = binding();
  const told: string[] = [];
  let ran = false;
  native.scheduleTimeout(1, () => {
    ran = true;
    throw { toString: () => (onCallbackError((error) => void told.push(error.message)), "registers a listener") };
  });
  for (let i = 0; i < 400 && !ran; i++) {
    native.pumpEvents();
    await Bun.sleep(5);
  }
  native.pumpEvents();
  result.told = told;
}

if (mode === "at-end") {
  const { onCallbackError } = await import("../../src/callback-errors");
  onCallbackError(() => {});
  // Nothing else is made, so nothing registers a release at exit: the process just ends.
} else {
  console.log("RESULT " + JSON.stringify(result));
  process.exit(0);
}
