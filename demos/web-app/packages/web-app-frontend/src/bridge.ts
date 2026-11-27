// One typed bridge for the whole page. Inside the app, calls go over the
// sweetview ring; in an Electron or Tauri 2 shell, over that shell's IPC; in a
// browser, over a WebSocket to the same origin. The line that picks the
// transport is the only one that knows which; the rest of the page does not.

import type { Events, Methods } from "web-app-backend/protocol";
import { createBridge, type Bridge, type TransportKind } from "@n1h/sweetview/ipc";
import { electronTransport, isElectron } from "@n1h/sweetview/ipc-electron/client";
import { isTauri, tauriTransport } from "@n1h/sweetview/ipc-tauri/client";
import { wsTransport, type WsTransport } from "@n1h/sweetview/ipc-ws/client";
import { isWebview, webviewTransport } from "@n1h/sweetview/page";

const transport = isWebview() ? webviewTransport() : isElectron() ? electronTransport() : isTauri() ? tauriTransport() : wsTransport();

export const bridge: Bridge<Methods, Events> = createBridge(transport);
export const rpc = bridge.rpc;
export const notify = bridge.notify;
export const on = bridge.on;
/** True in the sweetview desktop app, whose UI thread answers the desktop-only methods (folder picker, notifications, tray theme). */
export const inApp = bridge.kind === "webview";

/** How the page reaches its backend, for the header badge. */
export const transportLabel: Record<TransportKind, string> = {
  webview: "sweetview · IPC",
  web: "Bun.serve · WebSocket",
  electron: "Electron · IPC",
  tauri: "Tauri 2 · IPC",
};

/** Fires when the WebSocket drops (only in a browser). */
export const onDisconnect = (fn: () => void): (() => void) => ("onClose" in transport ? (transport as WsTransport).onClose(fn) : () => {});
