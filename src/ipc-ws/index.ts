// Import "@n1h/sweetview/ipc-ws/server" from Bun code and "@n1h/sweetview/ipc-ws/client" from the
// page; this root re-exports both for convenience in code that is bundled
// for one side only.
export { wsHost, type WsData, type WsHost, type WsHostOptions } from "./server";
export { wsTransport, wsUrl, type WsTransport } from "./client";
