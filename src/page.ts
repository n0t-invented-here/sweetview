// Page side. Safe to import in browser code: no Bun, no FFI.
//
// The UI thread binds `__sweetview_rpc(method, params)` into the page with
// webview_bind, and delivers events by evaluating `__sweetview_emit(name,
// payload)`, which this module installs.

import type { Transport } from "./ipc";

declare global {
  interface Window {
    __sweetview_rpc?: (method: string, params: unknown) => Promise<unknown>;
    __sweetview_emit?: (name: string, payload: unknown) => void;
  }
}

/** True when the page is running inside a sweetview window. */
export const isWebview = (): boolean => typeof window !== "undefined" && typeof window.__sweetview_rpc === "function";

// One emit global per page, shared by every transport created on it.
const listeners = new Set<(name: string, payload: unknown) => void>();

export function webviewTransport(): Transport {
  const rpc = typeof window !== "undefined" ? window.__sweetview_rpc : undefined;
  if (!rpc) throw new Error("not running inside sweetview");
  window.__sweetview_emit ??= (name, payload) => {
    for (const fn of listeners) fn(name, payload);
  };

  const call = (method: string, params: unknown) =>
    rpc(method, params).then(
      (r) => r,
      (e: unknown) => {
        // webview rejects with the JSON passed to webview_return(status=1): { message }
        const message = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
        throw new Error(message);
      },
    );

  return {
    kind: "webview",
    call,
    notify: (method, params) => void call(method, params).catch((e: Error) => console.error(`${method} failed:`, e.message)),
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
