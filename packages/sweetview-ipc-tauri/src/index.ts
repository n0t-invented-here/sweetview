// The page side of Sweetview IPC in a Tauri 2 webview. The host side is the
// Tauri application's Rust code; docs/ipc-tauri.md specifies the frames it
// handles.
export { TAURI_COMMAND, TAURI_EVENT, isTauri, tauriGlobalApi, tauriTransport, type TauriApi, type TauriInvoke, type TauriListen, type TauriTransport } from "./client";
