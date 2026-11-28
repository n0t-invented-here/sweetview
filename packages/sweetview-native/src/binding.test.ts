// The boundary between Bun and the Rust binding (rust-rewrite/CHECKLIST-windows.md, group W1).

import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ring } from "../../sweetview/src/ring";
import { binding, loadBindingFrom } from "./binding";
import { pureAnswers } from "../test/pure-answers";

const onWindows = process.platform === "win32";
const UI_THREAD_ERROR = "sweetview: this call must be made on the UI thread";

// A real PE file built for another architecture: the 32-bit x86 kernel32.dll of WOW64. An x64
// process cannot load it (ERROR_BAD_EXE_FORMAT).
const x86Pe = join(process.env.SystemRoot ?? "C:\\Windows", "SysWOW64", "kernel32.dll");
const haveX86Pe = onWindows && existsSync(x86Pe);
/** The machine field of a PE file's COFF header: 0x14c is i386, 0x8664 is x64. */
function peMachine(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (view.getUint16(0, true) !== 0x5a4d || view.getUint32(pe, true) !== 0x4550) throw new Error("not a PE file");
  return view.getUint16(pe + 4, true);
}

/**
 * Runs the package's real loader (`src/binding.ts`, copied unchanged) in a process of its own, from
 * a folder whose `prebuilt/` holds `prebuilt` as `sweetview.win32-x64-msvc.node`, or nothing. So the
 * literal `require("../prebuilt/sweetview.win32-x64-msvc.node")` and its failure branch run as an
 * installed package runs them. Returns what `binding()` threw (the whole message, every line), or "LOADED".
 */
function loadInFolderOfItsOwn(prebuilt: Uint8Array | null): { outcome: string; exitCode: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "sweetview-loader-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "prebuilt"));
    copyFileSync(fileURLToPath(new URL("./binding.ts", import.meta.url)), join(dir, "src", "binding.ts"));
    if (prebuilt) writeFileSync(join(dir, "prebuilt", "sweetview.win32-x64-msvc.node"), prebuilt);
    writeFileSync(
      join(dir, "run.ts"),
      `import { binding } from "./src/binding";\ntry { binding(); console.log("OUTCOME LOADED"); } catch (err) { console.log("OUTCOME " + (err as Error).message); }\n`,
    );
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.SWEETVIEW_NATIVE_PATH;
    const run = Bun.spawnSync([process.execPath, join(dir, "run.ts")], { cwd: dir, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const stdout = run.stdout.toString();
    const at = stdout.search(/^OUTCOME /m);
    if (at < 0) throw new Error(`the loader gave no outcome (exit ${run.exitCode})\n${run.stdout}\n${run.stderr}`);
    return { outcome: stdout.slice(at + "OUTCOME ".length).trimEnd(), exitCode: run.exitCode };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  test.skipIf(!haveX86Pe)("a binary for another platform fails with a message that names the file looked for", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweetview-binding-"));
    const wrong = join(dir, "sweetview.win32-ia32-msvc.node");
    // A real PE file for another architecture (i386), not a stub.
    const bytes = new Uint8Array(readFileSync(x86Pe));
    expect(peMachine(bytes)).toBe(0x14c);
    writeFileSync(wrong, bytes);
    expect(() => loadBindingFrom(wrong)).toThrow(`sweetview: the native binding could not be loaded from ${wrong}: `);
  });

  // The loader's literal require and its failure branch, as an installed package runs them.
  const LOOKED_FOR = "sweetview: the native binding could not be loaded from @n1h/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node: ";
  // What follows when the file is not there: how to build it in a checkout, and what it means in an install.
  const NOT_BUILT = ["The file is not there.", "run `just native build`", "rustup", "SWEETVIEW_NATIVE_PATH", "broken install"];

  test("the literal require: with prebuilt/ empty, binding() fails with a message that names the file looked for", () => {
    const { outcome, exitCode } = loadInFolderOfItsOwn(null);
    expect(exitCode).toBe(0);
    expect(outcome.startsWith(LOOKED_FOR)).toBe(true);
    expect(outcome.length).toBeGreaterThan(LOOKED_FOR.length); // the OS's or Bun's reason follows
    // then, on a line of its own, what to run
    const hint = outcome.slice(outcome.lastIndexOf("\n") + 1);
    for (const part of NOT_BUILT) expect(hint).toContain(part);
  });

  test.skipIf(!haveX86Pe)("the literal require: with an i386 PE file in its place, binding() fails with a message that names the file looked for", () => {
    const bytes = new Uint8Array(readFileSync(x86Pe));
    expect(peMachine(bytes)).toBe(0x14c);
    const { outcome, exitCode } = loadInFolderOfItsOwn(bytes);
    expect(exitCode).toBe(0);
    expect(outcome.startsWith(LOOKED_FOR)).toBe(true);
    expect(outcome.length).toBeGreaterThan(LOOKED_FOR.length);
    expect(outcome).not.toContain(NOT_BUILT[0]); // the file is there, so building it is not the answer
  });

  test("the literal require: with the real binding in its place, the same copied loader loads it (the control)", () => {
    const real = new Uint8Array(readFileSync(fileURLToPath(new URL("../prebuilt/sweetview.win32-x64-msvc.node", import.meta.url))));
    expect(peMachine(real)).toBe(0x8664);
    expect(loadInFolderOfItsOwn(real)).toEqual({ outcome: "LOADED", exitCode: 0 });
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

  // What a handle scope per call changes, measured. Under Bun's N-API every value handed to native
  // code (a callback's arguments, and what it returns, which napi_call_function hands back) is held
  // by the handle scope open at that moment. Without a scope per call, the scope open during a
  // callback is the one of the outer native call, runLoop(), so everything every callback returned
  // stays reachable until runLoop() returns, exactly as if it were kept in an array. The test
  // counts ArrayBuffers on the JS heap after a full collection, from inside the same blocking run:
  // returned and dropped, they are gone; kept deliberately (the control), they are all there.
  test("each call opens its own handle scope: what 400 callbacks return is collected before the blocking run returns; kept deliberately, it is not", () => {
    const native = binding();
    const N = 400;
    const buffers = () => heapStats().objectTypeCounts.ArrayBuffer ?? 0;
    const measure = (keep: boolean) => {
      const kept: ArrayBuffer[] = [];
      Bun.gc(true);
      const before = buffers();
      let inside = -1;
      let blocking = false;
      for (let i = 0; i < N; i++) {
        native.defer(() => {
          const fresh = new ArrayBuffer(64 * 1024);
          if (keep) kept.push(fresh);
          // Returned to the binding, which receives it as napi_call_function's result.
          return fresh as unknown as void;
        });
      }
      native.scheduleTimeout(30, () => {
        blocking = native.isLoopBlocking();
        Bun.gc(true);
        inside = buffers();
        native.quitLoop();
      });
      native.runLoop();
      return { grew: inside - before, blocking, kept: kept.length };
    };
    const dropped = measure(false);
    const retained = measure(true);
    // Measured inside the blocking run.
    expect(dropped.blocking).toBe(true);
    expect(retained.blocking).toBe(true);
    // The control: N buffers kept alive are all counted, so the measurement sees retention.
    expect(retained.kept).toBe(N);
    expect(retained.grew).toBeGreaterThanOrEqual(N);
    // With a scope per call, none of the N returned buffers outlives its call (a few may sit on
    // the native stack, which the collector scans conservatively).
    expect(dropped.grew).toBeLessThan(N / 20);
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
    | { kind: "written"; woke: boolean }
    | { kind: "pure"; isUiThread: boolean; answers: unknown };

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

  // docs/native.md: menu templates (resolveMenu), hit-region geometry, the icon encoders and the
  // PNG decoder, and the regular-file helpers are pure TypeScript, callable on any thread.
  test("the pure-TypeScript functions docs/ calls any-thread (resolveMenu, packRegions/hitRegions, dotPng/decodePng/icoFromPng, readTextFile) give the UI thread's answers in a Worker", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sweetview-pure-")), "note.txt");
    writeFileSync(file, "read in a worker");
    const onUi = await pureAnswers(file);
    const { worker, next } = openWorker();
    try {
      const reply = next();
      worker.postMessage({ kind: "pure", file });
      const inWorker = await reply;
      if (inWorker.kind !== "pure") throw new Error(`unexpected reply ${JSON.stringify(inWorker)}`);
      expect(inWorker.isUiThread).toBe(false);
      expect(inWorker.answers).toEqual(onUi);
      expect(onUi).toMatchObject({ menu: ["Open", "separator"], hits: [true, false], png: { width: 24, height: 24 }, icoHeader: [0, 0, 1, 0, 2, 0], text: "read in a worker" });
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
