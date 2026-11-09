// What crosses worker.postMessage, UI thread -> worker. The other direction
// (worker -> UI thread) is sweetipc frames in the ring.

import type { CallFrame } from "./ipc";

export type InitMessage = {
  kind: "init";
  ring: SharedArrayBuffer;
  webviewHandle: number;
  drainCallbackPtr: number;
  libPath: string;
};

export type WorkerMessage = InitMessage | CallFrame;

export const WEBVIEW_SESSION = { id: "webview", kind: "webview" } as const;
