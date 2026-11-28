// macOS only, until the macOS goal of the Rust rewrite replaces it: the
// `WebviewHost` over the webview library of @n1h/sweetview-webview-bun, called
// through bun:ffi. This is the code `app.ts` held before the Windows goal,
// moved here unchanged in behaviour. On Windows nothing here is loaded.

import { CString, FFIType, JSCallback, toArrayBuffer, type Pointer } from "bun:ffi";
import type { RawWebview } from "@n1h/sweetview-native";
import { reportCallbackError } from "@n1h/sweetview-native/internal";
import {
  allowExternalDropCall,
  backgroundColorCall,
  fileDropHandlerCall,
  openWebviewCore,
  requestHandlerCalls,
  setAssetCall,
  streamingResponseCalls,
  webviewLibPath,
} from "./darwin-webview-lib";
import type { NativeRequest } from "./messages";
import { requestError } from "./request-response";
import type { WebviewEngine, WebviewHost } from "./webview-host";

let nextDispatchId = 0n;
const pendingUiDispatches = new Map<bigint, () => void>();
const workerDrains = new Map<bigint, () => void>();
// Cocoa may invoke an already-posted dispatch after the webview is gone. The
// native trampoline stays valid while shutdown drops the per-view queue and
// its dispatch token.
let nativeDispatch: JSCallback | undefined;
function nativeDispatchPointer(): Pointer {
  nativeDispatch ??= new JSCallback(
    (_webview, id: bigint) => {
      const dispatch = pendingUiDispatches.get(id);
      const run = dispatch ?? workerDrains.get(id);
      pendingUiDispatches.delete(id);
      try {
        run?.();
      } catch (err) {
        reportCallbackError(dispatch ? "deferred" : "worker", err, "sweetview: UI dispatch failed:");
      }
    },
    { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
  );
  if (!nativeDispatch.ptr) throw new Error("sweetview: could not allocate the UI dispatcher");
  return nativeDispatch.ptr;
}

function libraryHost(libPath: string, raw: RawWebview): WebviewHost {
  const core = openWebviewCore(libPath);
  const handle = () => Number(raw.unsafeHandle) as Pointer;
  const requestCalls = requestHandlerCalls(libPath);
  const streamCalls = streamingResponseCalls(libPath);
  let requestCallback: JSCallback | undefined;
  let dropCallback: JSCallback | undefined;
  let dropHandler: ((paths: string[]) => void) | undefined;
  // True while native holds the drop trampoline: it must not be freed under native.
  let dropRegistered = false;

  return {
    setAsset(path, mime, bytes) {
      const setAsset = setAssetCall(libPath);
      if (!setAsset) {
        throw new Error("sweetview: this webview library has no webview_set_asset; it needs the library @n1h/sweetview-webview-bun ships (is WEBVIEW_PATH pointing at a stock one?)");
      }
      return setAsset(handle(), path, mime, bytes);
    },
    setBackgroundColor: (r, g, b, a) => backgroundColorCall(libPath)?.(handle(), r, g, b, a),
    setAllowExternalDrop: (allow) => allowExternalDropCall(libPath)?.(handle(), allow ? 1 : 0),
    setRequestHandler(handler) {
      if (!requestCalls) return -1;
      if (!handler) {
        return raw.unsafeHandle !== null ? requestCalls.setRequestHandler(handle(), null, null) : 0;
      }
      requestCallback?.close();
      requestCallback = new JSCallback(
        (id: bigint, method: Pointer, url: Pointer, headers: Pointer | null, body: Pointer | null, length: bigint) => {
          // The native strings and body belong to the callback. Copy
          // them before the view returns control to the browser.
          let request: NativeRequest;
          try {
            request = {
              id,
              method: new CString(method).toString(),
              url: new CString(url).toString(),
              headers: headers ? JSON.parse(new CString(headers).toString()) : [],
              body: body && length > 0n ? new Uint8Array(toArrayBuffer(body, 0, Number(length))).slice() : new Uint8Array(),
            };
          } catch {
            // Answered as `app.ts` answered it before the Windows goal: its 500, through the same call.
            const answer = requestError(id, 500, "Internal Server Error");
            const error = requestCalls.completeRequest(handle(), id, answer.status, JSON.stringify(answer.headers), answer.body);
            if (error !== 0) console.error(`sweetview: webview_complete_request failed (${error})`);
            return;
          }
          handler(request);
        },
        {
          args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
          returns: FFIType.void,
        },
      );
      return requestCalls.setRequestHandler(handle(), requestCallback.ptr, null);
    },
    completeRequest: (id, status, headersJson, body) => (requestCalls ? requestCalls.completeRequest(handle(), id, status, headersJson, body) : -1),
    streaming: streamCalls && {
      begin: (id, status, headersJson) => streamCalls.beginResponse(handle(), id, status, headersJson),
      write: (id, chunk) => streamCalls.writeResponseChunk(handle(), id, chunk),
      end: (id) => streamCalls.endResponse(handle(), id),
    },
    setFileDropHandler(handler) {
      const set = fileDropHandlerCall(libPath);
      if (!set) return undefined;
      if (handler) {
        dropHandler = handler;
        dropCallback ??= new JSCallback(
          (json: Pointer | null) => {
            if (!dropRegistered || !json) return;
            let paths: unknown;
            try {
              paths = JSON.parse(new CString(json).toString());
            } catch {
              return;
            }
            if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) dropHandler?.(paths);
          },
          { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
        );
      }
      const error = set(handle(), handler ? dropCallback!.ptr : null, null);
      // On failure native keeps whatever it had, so the state stays as it was.
      if (error === 0) {
        dropRegistered = handler !== null;
        if (!handler) {
          dropHandler = undefined;
          dropCallback?.close();
          dropCallback = undefined;
        }
      }
      return error;
    },
    run() {
      core.webview_run(handle());
    },
    quit() {
      if (raw.unsafeHandle !== null) core.webview_terminate(handle());
    },
    dispatch(job) {
      const id = ++nextDispatchId;
      pendingUiDispatches.set(id, job);
      let error: number;
      try {
        error = core.webview_dispatch(handle(), nativeDispatchPointer(), id);
      } catch (err) {
        pendingUiDispatches.delete(id);
        throw err;
      }
      if (error !== 0) {
        pendingUiDispatches.delete(id);
        throw new Error(`sweetview: webview_dispatch failed (${error})`);
      }
      return () => pendingUiDispatches.delete(id);
    },
    openDrain(drain) {
      const drainToken = ++nextDispatchId;
      workerDrains.set(drainToken, drain);
      return {
        wake: {
          kind: "library",
          libPath,
          webviewHandle: Number(raw.unsafeHandle),
          drainCallbackPtr: Number(nativeDispatchPointer()),
          drainToken,
        },
        close: () => workerDrains.delete(drainToken),
      };
    },
    dispose() {
      requestCallback?.close();
      requestCallback = undefined;
      // Only once webview_destroy has run can a drop trampoline native failed to unregister be freed.
      dropRegistered = false;
      dropHandler = undefined;
      dropCallback?.close();
      dropCallback = undefined;
    },
  };
}

/** The engine over the webview library. Resolves once the library's path is known. */
export async function libraryEngine(): Promise<WebviewEngine> {
  const libPath = await webviewLibPath();
  return {
    hasRequests: requestHandlerCalls(libPath) !== undefined,
    host: (raw) => libraryHost(libPath, raw),
  };
}
