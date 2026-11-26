// What crosses worker.postMessage, UI thread -> worker. The other direction
// (worker -> UI thread) is IPC and binary HTTP response frames in the ring.

import type { CallFrame } from "@n1h/sweetview-ipc";

export type InitMessage = {
  kind: "init";
  ring: SharedArrayBuffer;
  webviewHandle: number;
  drainCallbackPtr: number;
  drainToken: bigint;
  libPath: string;
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

export type HttpRequestMessage = NativeRequest & { kind: "http-request" };
export type WorkerMessage = InitMessage | CallFrame | HttpRequestMessage;

export const WEBVIEW_SESSION = { id: "webview", kind: "webview" } as const;
