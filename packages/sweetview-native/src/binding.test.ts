// The boundary between Bun and the Rust binding (rust-rewrite/CHECKLIST-windows.md, group W1).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ring } from "../../sweetview/src/ring";
import { binding, loadBindingFrom } from "./binding";

const onWindows = process.platform === "win32";
const UI_THREAD_ERROR = "sweetview: this call must be made on the UI thread";

/** Captures what the binding writes to stderr through console.error's sibling, process.stderr. */
function withTimeout<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)),
  ]);
}

describe.if(onWindows)("native binding: loading (W1.1)", () => {
  test("the binding loads with a literal require and reports the UI thread", () => {
    const native = binding();
    expect(typeof native.pumpEvents).toBe("function");
    expect(native.isUiThread()).toBe(true);
  });

  test("a missing binary fails with a message that names the file looked for", () => {
    const missing = join(tmpdir(), "sweetview-no-such-binding.node");
    expect(() => loadBindingFrom(missing)).toThrow(`sweetview: the native binding could not be loaded from ${missing}`);
  });

  test("a binary for another platform fails with a message that names the file looked for", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweetview-binding-"));
    const wrong = join(dir, "sweetview.linux-x64-gnu.node");
    // An ELF header: what a Linux binding starts with. Windows cannot load it.
    writeFileSync(wrong, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(() => loadBindingFrom(wrong)).toThrow(`sweetview: the native binding could not be loaded from ${wrong}`);
  });
});

describe.if(onWindows)("native binding: callbacks from inside the loop (W1.2, W1.4)", () => {
  test("a JavaScript function is called from inside the blocking loop and its return value comes back", () => {
    const native = binding();
    let insideLoop = false;
    let calledInside: boolean | undefined;
    let received: string | null | undefined;
    native.probeRoundTrip(
      5,
      "ping",
      (input) => {
        calledInside = insideLoop && native.isLoopBlocking();
        return `pong<${input}>`;
      },
      (output) => {
        received = output;
        native.quitLoop();
      },
    );
    insideLoop = true;
    native.runLoop();
    insideLoop = false;
    expect(calledInside).toBe(true);
    expect(received).toBe("pong<ping>");
    expect(native.isLoopBlocking()).toBe(false);
  });

  test("each call opens its own handle scope: ten thousand callbacks inside one blocking run", () => {
    const native = binding();
    let calls = 0;
    const interval = native.scheduleInterval(1, () => {
      // Many callbacks per timer tick, each allocating: without a scope per call these handles
      // would all live until runLoop returns.
      for (let i = 0; i < 1000; i++) native.defer(() => void (calls += [i, { i }, `${i}`].length / 3));
      if (calls >= 10_000) native.quitLoop();
    });
    native.runLoop();
    native.cancelTimeout(interval);
    expect(calls).toBeGreaterThanOrEqual(10_000);
  });

  test("a callback may remove itself, and may destroy its owner, from inside its own call", () => {
    const native = binding();
    let ticks = 0;
    let drained = 0;
    // An interval that cancels itself on its first run.
    const interval: number = native.scheduleInterval(1, () => {
      ticks++;
      native.cancelTimeout(interval);
    });
    // A drain function that removes itself, then replaces itself, from inside its own call.
    native.setDrain(7001, () => {
      drained++;
      native.setDrain(7001, null);
      native.setDrain(7001, () => {
        drained += 10;
        native.setDrain(7001, null);
      });
      native.wake(7001);
    });
    native.wake(7001);
    native.scheduleTimeout(60, () => native.quitLoop());
    native.runLoop();
    expect(ticks).toBe(1);
    expect(drained).toBe(11);
    expect(native.wake(7001)).toBe(true); // the wake is delivered; no drain is registered, so nothing runs
  });
});

describe.if(onWindows)("native binding: both loop modes (W4.1 mechanism)", () => {
  test("the pumped loop delivers native timeouts while Bun timers and promises keep running", async () => {
    const native = binding();
    let nativeFired = 0;
    let bunTicks = 0;
    let promises = 0;
    const id = native.scheduleInterval(5, () => void nativeFired++);
    const side = setInterval(() => {
      bunTicks++;
      void Promise.resolve().then(() => promises++);
    }, 5);
    await new Promise<void>((resolve) => {
      const pump = setInterval(() => {
        native.pumpEvents();
        if (nativeFired >= 5 && bunTicks >= 5) {
          clearInterval(pump);
          resolve();
        }
      }, 4);
    });
    clearInterval(side);
    native.cancelTimeout(id);
    expect(nativeFired).toBeGreaterThanOrEqual(5);
    expect(bunTicks).toBeGreaterThanOrEqual(5);
    expect(promises).toBeGreaterThanOrEqual(4);
  });
});

describe.if(onWindows)("native binding: threads (W1.5, W1.7)", () => {
  type Reply =
    | { kind: "probed"; isUiThread: boolean; refused: Record<string, string> }
    | { kind: "written"; woke: boolean };

  function openWorker() {
    const worker = new Worker(new URL("./binding.test.worker.ts", import.meta.url).href);
    const next = () =>
      withTimeout(
        new Promise<Reply>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data as Reply);
          worker.onerror = (event) => reject(new Error(event.message));
        }),
        "the worker",
      );
    return { worker, next };
  }

  test("a UI-thread function called from a Worker throws, and the worker is not the UI thread", async () => {
    const { worker, next } = openWorker();
    try {
      const reply = next();
      worker.postMessage({ kind: "probe" });
      const probed = await reply;
      if (probed.kind !== "probed") throw new Error("unexpected reply");
      expect(probed.isUiThread).toBe(false);
      expect(Object.keys(probed.refused).sort()).toEqual(
        ["cancelTimeout", "defer", "isLoopBlocking", "pumpEvents", "quitLoop", "runLoop", "scheduleInterval", "scheduleTimeout", "setDrain"],
      );
      for (const message of Object.values(probed.refused)) expect(message).toBe(UI_THREAD_ERROR);
      expect(binding().isUiThread()).toBe(true);
    } finally {
      worker.terminate();
    }
  });

  test("from a Worker, a frame written to the ring then wake() runs the drain on the UI thread inside the blocking loop", async () => {
    const native = binding();
    const { worker, next } = openWorker();
    try {
      // Let the worker load the binding before the UI thread blocks.
      const probed = next();
      worker.postMessage({ kind: "probe" });
      await probed;

      const sab = Ring.create(1024);
      const ring = new Ring(sab);
      const frames: string[] = [];
      let drainedInsideBlockingLoop = false;
      native.setDrain(7101, () => {
        ring.acknowledgeWakeup();
        drainedInsideBlockingLoop = native.isLoopBlocking() && native.isUiThread();
        for (const bytes of ring.drain()) frames.push(new TextDecoder().decode(bytes));
        native.quitLoop();
      });
      worker.postMessage({ kind: "write", ring: sab, token: 7101, text: "from the worker, blocking" });
      // Safety net: the test fails on the expectation below rather than hanging.
      const watchdog = native.scheduleTimeout(8000, () => native.quitLoop());
      native.runLoop();
      native.cancelTimeout(watchdog);
      native.setDrain(7101, null);
      expect(frames).toEqual(["from the worker, blocking"]);
      expect(drainedInsideBlockingLoop).toBe(true);
    } finally {
      worker.terminate();
    }
  });

  test("from a Worker, a frame written to the ring then wake() runs the drain on the UI thread under the timer-pumped loop", async () => {
    const native = binding();
    const { worker, next } = openWorker();
    const pump = setInterval(() => native.pumpEvents(), 4);
    try {
      const sab = Ring.create(1024);
      const ring = new Ring(sab);
      const drained = withTimeout(
        new Promise<{ frames: string[]; blocking: boolean; ui: boolean }>((resolve) => {
          native.setDrain(7102, () => {
            ring.acknowledgeWakeup();
            const frames = [...ring.drain()].map((bytes) => new TextDecoder().decode(bytes));
            resolve({ frames, blocking: native.isLoopBlocking(), ui: native.isUiThread() });
          });
        }),
        "the drain",
      );
      const written = next();
      worker.postMessage({ kind: "write", ring: sab, token: 7102, text: "from the worker, pumped" });
      expect(await written).toEqual({ kind: "written", woke: true });
      expect(await drained).toEqual({ frames: ["from the worker, pumped"], blocking: false, ui: true });
      native.setDrain(7102, null);
    } finally {
      clearInterval(pump);
      worker.terminate();
    }
  });
});
