// macOS only, until the macOS goal of the Rust rewrite replaces it: the worker opens
// the webview library itself and wakes the UI thread with `webview_dispatch`.

import type { Pointer } from "bun:ffi";
import { openWebviewCore } from "./darwin-webview-lib";
import type { WorkerWake } from "./webview-host";

export function libraryWake(wake: Extract<WorkerWake, { kind: "library" }>): () => void {
  const { webview_dispatch: dispatch } = openWebviewCore(wake.libPath);
  const handle = wake.webviewHandle as Pointer;
  const callback = wake.drainCallbackPtr as Pointer;
  return () => void dispatch(handle, callback, wake.drainToken);
}
