// What crosses worker.postMessage, UI thread -> worker. The other direction
// (worker -> UI thread) is IPC and binary HTTP response frames in the ring.

import type { CallFrame } from "@n1h/sweetview-ipc";
import type { WorkerWake } from "./webview-host";

export type InitMessage = {
  kind: "init";
  ring: SharedArrayBuffer;
  /** How the worker wakes the UI thread after it writes to the ring. */
  wake: WorkerWake;
};

export type NativeRequest = {
  id: bigint;
  method: string;
  url: string;
  headers: [name: string, value: string][];
  body: Uint8Array<ArrayBuffer>;
};

export type NativeResponse = {
  status?: number;
  headers?: Record<string, string> | [name: string, value: string][];
  body?: Uint8Array | ArrayBuffer | string | null;
};

/**
 * Worker -> UI, through the ring: the worker hit an uncaught error or an
 * unhandled rejection and is going down. The UI thread drains the ring via
 * webview_dispatch even while webview_run() blocks the main thread's event
 * loop (where Worker.onerror cannot fire), so this is how a crash reaches it.
 */
export type WorkerCrashFrame = { kind: "workerError"; message: string };

export type HttpRequestMessage = NativeRequest & { kind: "http-request" };
export type WorkerMessage = InitMessage | CallFrame | HttpRequestMessage;

export const WEBVIEW_SESSION = { id: "webview", kind: "webview" } as const;
