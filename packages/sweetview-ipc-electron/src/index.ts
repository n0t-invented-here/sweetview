// Import "@n1h/sweetview/ipc-electron/server" from Electron's main process,
// "@n1h/sweetview/ipc-electron/preload" from the preload script and
// "@n1h/sweetview/ipc-electron/client" from the page; this root re-exports all
// three for code bundled for one side only. None of them imports "electron".
export { ELECTRON_API_KEY, ELECTRON_CHANNEL, ELECTRON_HELLO_CHANNEL, type SweetviewIpcApi } from "./channel";
export { electronTransport, isElectron, type ElectronTransport } from "./client";
export { createSweetviewIpcApi, exposeSweetviewIpc, type ContextBridgeLike, type IpcRendererLike } from "./preload";
export { electronHost, type ElectronHost, type ElectronHostOptions, type IpcMainEventLike, type IpcMainLike, type WebContentsLike } from "./server";
