// A Worker that loads the binding before the main thread does (binding.test.ts, review round 1 of
// the split, Z1): the UI thread is Bun's main thread, so the Worker's UI-thread call is refused and
// the main thread, loading after it, runs the loop.

import { quitEventLoop, runEventLoop } from "../../src/index";
import { binding } from "../../src/binding";

const source = `const { binding } = await import(${JSON.stringify(new URL("../../src/binding.ts", import.meta.url).href)});
  try { binding().isLoopBlocking(); postMessage({ isUiThread: binding().isUiThread(), refused: "no error" }); }
  catch (err) { postMessage({ isUiThread: binding().isUiThread(), refused: String(err && err.message) }); }`;
const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "application/typescript" })));
const fromWorker = await new Promise<{ isUiThread: boolean; refused: string }>((resolve) => (worker.onmessage = (e) => resolve(e.data)));
worker.terminate();

const mainIsUiThread = binding().isUiThread();
let loopRan = false;
setTimeout(() => {
  loopRan = true;
  quitEventLoop();
}, 50);
await runEventLoop();
console.log("RESULT " + JSON.stringify({ worker: fromWorker, mainIsUiThread, loopRan }));
process.exit(0);
