// Internal, Worker side. How the worker wakes the UI thread after it writes to the ring.
//
// Windows: the Rust binding, loaded a second time inside the Worker; its `wake` posts
// to the UI thread's signal window. macOS: the webview library's `webview_dispatch`,
// in `./darwin-worker-wake`, until the macOS goal of the rewrite.

import { wakeNative } from "@n1h/sweetview-native/internal";
import type { WorkerWake } from "./webview-host";

export function workerWake(wake: WorkerWake): () => void {
  if (wake.kind === "native") {
    const { token } = wake;
    return () => void wakeNative(token);
  }
  return (require("./darwin-worker-wake") as typeof import("./darwin-worker-wake")).libraryWake(wake);
}
