// Internal. What `WebView.attach` asks of the webview engine beyond the
// `RawWebview` class, behind one interface with an implementation per platform:
//
// - Windows: the Rust binding, through `RawWebview` and `@n1h/sweetview-native`.
// - macOS: the webview library of `@n1h/sweetview-webview-bun`, called through
//   `bun:ffi` in `./darwin-webview-host`, until the macOS goal of the rewrite.
//
// Each optional member is `undefined` when the engine underneath does not have
// that feature (an older webview library on macOS); the Rust binding has all.

import { RawWebview, WebviewError } from "@n1h/sweetview-native";
import { deferNative, isWebviewResponseBacklogged, openNativeDrain, quitNativeLoop, runNativeLoop } from "@n1h/sweetview-native/internal";
import type { NativeRequest } from "./messages";

/** What a `Worker` needs to wake the UI thread; it travels in the worker's init message. */
export type WorkerWake =
  | { kind: "native"; token: number }
  | { kind: "library"; libPath: string; webviewHandle: number; drainCallbackPtr: number; drainToken: bigint };

export interface WebviewHost {
  /** Serves bytes at a path of the page's origin. Returns a `webview_error_t`. */
  setAsset(path: string, mime: string, bytes: Uint8Array): number;
  /** `undefined` when the engine has no background colour call. */
  setBackgroundColor(r: number, g: number, b: number, a: number): number | undefined;
  /** `undefined`, after a warning, when the engine has no external drop control. */
  setAllowExternalDrop(allow: boolean): number | undefined;
  setRequestHandler(handler: ((request: NativeRequest) => void) | null): number;
  completeRequest(id: bigint, status: number, headersJson: string, body: Uint8Array): number;
  /** `undefined` when the engine cannot stream a response body; responses are then buffered. */
  readonly streaming:
    | {
        begin(id: bigint, status: number, headersJson: string): number;
        write(id: bigint, chunk: Uint8Array): number;
        end(id: bigint): number;
        /**
         * Whether the page is behind on response `id` (1 MiB unread, until it is
         * down to half). `undefined` when the engine keeps no count; the writer
         * is then never paced.
         */
        backlogged?(id: bigint): boolean;
      }
    | undefined;
  /** `undefined` when the engine has no file drop handler. */
  setFileDropHandler(handler: ((paths: string[]) => void) | null): number | undefined;
  /** Blocks in the OS loop until `quit()`. */
  run(): void;
  /** Ends the `run()` in progress. */
  quit(): void;
  /** Queues `job` for a later native UI tick, inside a modal loop too. Returns a function that forgets it. Throws when it cannot be queued. */
  dispatch(job: () => void): () => void;
  /** Makes `drain` what the worker's wake runs on the UI thread. */
  openDrain(drain: () => void): { wake: WorkerWake; close(): void };
  /** Frees what the host holds natively. Call once the webview is destroyed. */
  dispose(): void;
}

const codeOf = (run: () => void): number => {
  try {
    run();
    return 0;
  } catch (err) {
    if (err instanceof WebviewError) return err.code;
    throw err;
  }
};

/** The host over the Rust binding. Every feature is present. */
function bindingHost(raw: RawWebview): WebviewHost {
  return {
    setAsset: (path, mime, bytes) => codeOf(() => raw.setAsset(path, mime, bytes)),
    setBackgroundColor: (r, g, b, a) => codeOf(() => raw.setBackgroundColor(r, g, b, a)),
    setAllowExternalDrop: (allow) => codeOf(() => raw.setAllowExternalDrop(allow)),
    setRequestHandler: (handler) =>
      codeOf(() =>
        raw.setRequestHandler(
          handler &&
            ((request) => {
              handler({ ...request, body: (request.body ?? new Uint8Array()) as Uint8Array<ArrayBuffer> });
            }),
        ),
      ),
    completeRequest: (id, status, headersJson, body) =>
      codeOf(() => raw.completeRequest(id, { status, headers: JSON.parse(headersJson), body })),
    streaming: {
      begin: (id, status, headersJson) => codeOf(() => raw.beginResponse(id, { status, headers: JSON.parse(headersJson) })),
      write: (id, chunk) => codeOf(() => raw.writeResponseChunk(id, chunk)),
      end: (id) => codeOf(() => raw.endResponse(id)),
      backlogged: (id) => raw.unsafeHandle !== null && isWebviewResponseBacklogged(raw.unsafeHandle, id),
    },
    setFileDropHandler: (handler) => codeOf(() => raw.setFileDropHandler(handler)),
    run: runNativeLoop,
    quit: quitNativeLoop,
    dispatch: deferNative,
    openDrain(drain) {
      const opened = openNativeDrain(drain);
      return { wake: { kind: "native", token: opened.token }, close: opened.close };
    },
    dispose() {},
  };
}

/** The engine underneath, and whether it can hand requests to a handler at all. */
export interface WebviewEngine {
  readonly hasRequests: boolean;
  /** The host for one webview made on this engine. */
  host(raw: RawWebview): WebviewHost;
}

/** This platform's engine. Resolves once it is ready to make webviews: on macOS, once the webview library's path is known. */
export async function webviewEngine(): Promise<WebviewEngine> {
  if (process.platform === "darwin") {
    return (require("./darwin-webview-host") as typeof import("./darwin-webview-host")).libraryEngine();
  }
  return { hasRequests: true, host: bindingHost };
}
