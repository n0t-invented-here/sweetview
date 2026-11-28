// One module per feature. Import what you use.
export { createTray, Tray, type TrayIcon, type TrayOptions } from "./tray";
export { createNotifier, Notifier, type NotificationClick, type NotificationOptions, type NotifierOptions } from "./notifications";
export { Screen, type ScreenInfo } from "./screen";
export {
  closeToTrayOnLastWindow,
  createWindow,
  Window,
  type Appearance,
  type HitRefiner,
  type Point,
  type Rect,
  type ResizeEdge,
  type TabHandle,
  type WindowHandle,
  type WindowOptions,
} from "./window";
export { convexHull, createHitRelay, flattenRegions, hitRegions, HitRelay, packRegions, unpackRegions, type HitPolygon, type HitProbe } from "./hit-regions";
export { pickFolder } from "./folder-picker";
export { setAppMenu, type AppMenuOptions } from "./app-menu";
export { setAppIcon } from "./app-icon";
export { Clipboard } from "./clipboard";
export { readTextFile, readFileBytes, openFileHandle, readFileChunk, closeFileHandle, closeAllFileHandles } from "./fs";
export { Menu, resolveMenu, type MenuItem, type MenuPopupOptions, type MenuSource, type MenuTemplate } from "./menu";
export {
  decodePng,
  dotIcns,
  dotIco,
  dotPng,
  encodeIcns,
  encodeIco,
  encodePng,
  icnsFromPng,
  icnsFromRgba,
  icoFromPng,
  icoFromRgba,
  APP_ICO_SIZES,
  renderDot,
  trimTransparent,
  type DecodedPng,
  type DotIconOptions,
  type Icon,
} from "./icon";
export { pumpEvents, quitEventLoop, runEventLoop, setActivationPolicy, type ActivationPolicy, type EventLoopOptions } from "./event-loop";
export {
  extractUrlFromArgs,
  onOpenUrl,
  registerUrlScheme,
  signalReady,
  singleInstance,
  unregisterUrlScheme,
  type RegisterUrlSchemeOptions,
  type SecondInstanceEvent,
  type SingleInstanceLock,
  type SingleInstanceOptions,
} from "./activation";
export { defineAppIdentity, type AppIdentity, type AppIdentityInput } from "@n1h/sweetview-settings";
export {
  beginWebviewResponse,
  completeWebviewRequest,
  endWebviewResponse,
  SizeHint,
  unload,
  Webview,
  Webview as RawWebview,
  WebviewError,
  WEBVIEW_VERSION,
  writeWebviewResponseChunk,
  type FileDropHandler,
  type RequestHandler,
  type Size,
  type WebviewHandle,
  type WebviewRequest,
  type WebviewResponse,
  type WebviewResponseHead,
} from "./webview";
export {
  installKeyboardHook,
  installMouseHook,
  KeyEvent,
  Modifier,
  modifiersFrom,
  MouseEvent,
  type KeyboardHook,
  type KeyHandler,
  type KeyMessage,
  type Modifiers,
  type MouseHandler,
  type MouseHook,
  type MouseMessage,
} from "./input-hooks";
export { Feature, Permission, permissions, type PermissionStatus } from "./permissions";
