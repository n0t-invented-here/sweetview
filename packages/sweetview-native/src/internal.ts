export { discardQuit, scheduleNativeTimeout } from "./event-loop";
export { emitActivationUrl } from "./activation";
export { releaseAll, releaseAtEnd, type ReleaseKind } from "./lifetime";
export { macosKeepsTagPath } from "./platform";
export { binding, provideBinding, type NativeBinding } from "./binding";
export { reportCallbackError } from "./callback-errors";
export { onUnload } from "./unload";
/** macOS, until its goal: the webview library's seam, loaded by `@n1h/sweetview` there only. */
export const loadDarwinWebview = () => import("./darwin/webview");
export { deferNative, openNativeDrain, quitNativeLoop, runNativeLoop, wakeNative } from "./ui-thread";
export {
  emitWindowFileDrop,
  emitWindowNewTab,
  emitWindowTabClose,
  emitWindowTabSelect,
  forwardWindowTabEvents,
  getWindowBackend,
  getWindowMeta,
  holdWindowNativeDispose,
  isWindowDisposed,
  onWindowDispose,
  onWindowFileDropListenersChange,
  preserveWindowGeometry,
  windowFileDropCount,
} from "./window";
