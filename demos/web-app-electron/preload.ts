// The window's preload script. Bundled to build/preload.cjs; Electron runs it
// sandboxed, before the page, in an isolated world. It exposes only
// window.sweetviewIpc (send and onMessage), never ipcRenderer itself.

import { contextBridge, ipcRenderer } from "electron";
import { exposeSweetviewIpc } from "@n1h/sweetview/ipc-electron/preload";

exposeSweetviewIpc({ contextBridge, ipcRenderer });
