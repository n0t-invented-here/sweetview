// Names shared by the three Electron pieces: the page transport, the preload
// script and the main-process host. Each frame crosses Electron IPC as one
// JSON string on ELECTRON_CHANNEL, so the page sees exactly the JSON values it
// would see over a WebSocket.

/** The ipcMain / ipcRenderer channel that carries every frame, both ways, as JSON text. */
export const ELECTRON_CHANNEL = "sweetview-ipc";

/** Sent by the preload script once per page load, so the host starts a fresh session for that page. */
export const ELECTRON_HELLO_CHANNEL = "sweetview-ipc:hello";

/** The `window` property the preload script exposes the API under. */
export const ELECTRON_API_KEY = "sweetviewIpc";

/**
 * What the preload script exposes to the page through `contextBridge`: two
 * functions, nothing of `ipcRenderer` itself.
 */
export type SweetviewIpcApi = {
  /** Sends one frame, JSON-encoded, to the main process. */
  send(text: string): void;
  /** Subscribes to frames from the main process, each JSON-encoded. Returns the unsubscribe function. */
  onMessage(fn: (text: string) => void): () => void;
};
