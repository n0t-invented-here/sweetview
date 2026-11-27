// The page side: a sweetipc Transport over the API the preload script exposes
// (`window.sweetviewIpc`). Safe to import in page code: no Bun, no Node, no
// Electron; it imports types only.

import type { Frame, Transport } from "@n1h/sweetview-ipc";
import { ELECTRON_API_KEY, type SweetviewIpcApi } from "./channel";

export { ELECTRON_API_KEY, type SweetviewIpcApi } from "./channel";

export type ElectronTransport = Transport & {
  /** Stops listening, rejects every pending call, and makes later calls reject. Safe to call twice. */
  dispose(): void;
};

const isApi = (value: unknown): value is SweetviewIpcApi =>
  typeof value === "object" && value !== null && typeof (value as SweetviewIpcApi).send === "function" && typeof (value as SweetviewIpcApi).onMessage === "function";

/** True when the page runs in an Electron window whose preload script called `exposeSweetviewIpc`. */
export const isElectron = (key: string = ELECTRON_API_KEY): boolean => isApi((globalThis as Record<string, unknown>)[key]);

// One counter per page, so two transports on the same page never share a seq.
let seq = 0;

export function electronTransport(api: SweetviewIpcApi | undefined = (globalThis as Record<string, unknown>)[ELECTRON_API_KEY] as SweetviewIpcApi | undefined): ElectronTransport {
  if (!isApi(api)) throw new Error("not running inside Electron with the sweetview preload");
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventListeners = new Set<(name: string, payload: unknown) => void>();
  let disposed = false;

  const off = api.onMessage((text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(text));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const frame = parsed as Frame;
    if (frame.kind === "reply") {
      const p = pending.get(frame.seq);
      if (!p) return; // another transport's reply, or one already settled
      pending.delete(frame.seq);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(frame.error));
    } else if (frame.kind === "event") {
      for (const fn of eventListeners) fn(frame.name, frame.payload);
    }
  });

  return {
    kind: "electron",
    call(method, params) {
      if (disposed) return Promise.reject(new Error(`${method}: transport disposed`));
      return new Promise((resolve, reject) => {
        const id = String(++seq);
        pending.set(id, { resolve, reject });
        try {
          api.send(JSON.stringify({ kind: "call", seq: id, method, params } satisfies Frame));
        } catch (err) {
          pending.delete(id);
          reject(err as Error);
        }
      });
    },
    notify(method, params) {
      if (disposed) return;
      try {
        api.send(JSON.stringify({ kind: "call", seq: null, method, params } satisfies Frame));
      } catch (err) {
        console.error(`${method} not sent:`, (err as Error).message);
      }
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      eventListeners.clear();
      for (const p of pending.values()) p.reject(new Error("transport disposed"));
      pending.clear();
    },
  };
}
