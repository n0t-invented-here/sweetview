// The preload script's half. Exposes two functions to the page through
// contextBridge and keeps ipcRenderer itself out of the page's reach. It does
// not import "electron": the preload passes its own `contextBridge` and
// `ipcRenderer`, so this module works in a sandboxed preload and in tests.
//
//   // preload.ts, bundled to one CommonJS file
//   import { contextBridge, ipcRenderer } from "electron";
//   import { exposeSweetviewIpc } from "@n1h/sweetview/ipc-electron/preload";
//   exposeSweetviewIpc({ contextBridge, ipcRenderer });

import { ELECTRON_API_KEY, ELECTRON_CHANNEL, ELECTRON_HELLO_CHANNEL, type SweetviewIpcApi } from "./channel";

export { ELECTRON_API_KEY, ELECTRON_CHANNEL, ELECTRON_HELLO_CHANNEL, type SweetviewIpcApi } from "./channel";

/** The part of Electron's `ipcRenderer` this module uses. */
export type IpcRendererLike = {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};

/** The part of Electron's `contextBridge` this module uses. */
export type ContextBridgeLike = {
  exposeInMainWorld(apiKey: string, api: unknown): void;
};

/** Builds the page API over `ipcRenderer`. `exposeSweetviewIpc` uses it; call it directly only where context isolation is off. */
export function createSweetviewIpcApi(ipcRenderer: IpcRendererLike): SweetviewIpcApi {
  return {
    send(text) {
      if (typeof text !== "string") throw new TypeError("sweetviewIpc.send takes a JSON string");
      ipcRenderer.send(ELECTRON_CHANNEL, text);
    },
    onMessage(fn) {
      const listener = (_event: unknown, text: unknown) => {
        if (typeof text === "string") fn(text);
      };
      ipcRenderer.on(ELECTRON_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(ELECTRON_CHANNEL, listener);
      };
    },
  };
}

/**
 * Exposes the page API as `window[key]` (default `window.sweetviewIpc`) and
 * tells the host a new page has loaded, which starts a fresh session for it.
 */
export function exposeSweetviewIpc(electron: { contextBridge: ContextBridgeLike; ipcRenderer: IpcRendererLike }, key: string = ELECTRON_API_KEY): void {
  electron.contextBridge.exposeInMainWorld(key, createSweetviewIpcApi(electron.ipcRenderer));
  electron.ipcRenderer.send(ELECTRON_HELLO_CHANNEL);
}
