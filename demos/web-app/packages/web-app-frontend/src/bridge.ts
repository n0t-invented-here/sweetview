// One typed bridge for the whole page. Inside the app, calls go over the
// sweetview ring; in a browser, over a WebSocket to the same origin.

import type { Events, Methods } from "web-app-backend/protocol";
import { createBridge, type Bridge } from "@n1h/sweetview/ipc";
import { wsTransport, type WsTransport } from "@n1h/sweetview/ipc-ws/client";
import { isWebview, webviewTransport } from "@n1h/sweetview/page";

const transport = isWebview() ? webviewTransport() : wsTransport();

export const bridge: Bridge<Methods, Events> = createBridge(transport);
export const rpc = bridge.rpc;
export const notify = bridge.notify;
export const on = bridge.on;
export const inApp = bridge.kind === "webview";

/** Fires when the WebSocket drops (never inside the app). */
export const onDisconnect = (fn: () => void): (() => void) => ("onClose" in transport ? (transport as WsTransport).onClose(fn) : () => {});
