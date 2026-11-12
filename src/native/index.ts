// One module per feature. Import what you use.
export { createTray, type Tray, type TrayIcon, type TrayOptions } from "./tray";
export { createNotifier, type NotificationClick, type NotificationOptions, type Notifier, type NotifierOptions } from "./notifications";
export { nativeWindow, type NativeWindow, type WindowHandle } from "./window";
export {
  createOverlayWindow,
  makeOverlay,
  type Overlay,
  type OverlayOptions,
  type OverlayWindowOptions,
  type HitRefiner,
  type Point,
  type Rect,
  type ResizeEdge,
} from "./overlay";
export { convexHull, createHitRelay, flattenRegions, hitRegions, packRegions, unpackRegions, type HitPolygon, type HitProbe, type HitRelay } from "./hit-regions";
export { pickFolder } from "./folder-picker";
export { installAppMenu, type AppMenuOptions } from "./app-menu";
export { setAppIcon } from "./app-icon";
export { resolveMenu, type MenuItem, type MenuSource, type MenuTemplate } from "./menu";
export {
  decodePng,
  dotIcns,
  dotIcon,
  dotPng,
  encodeIcns,
  encodeIco,
  encodePng,
  icnsFromPng,
  icnsFromRgba,
  icoFromPng,
  icoFromRgba,
  renderDot,
  trimTransparent,
  type DecodedPng,
  type DotIconOptions,
  type Icon,
} from "./icon";
export { pumpEvents, quitEventLoop, runEventLoop, setActivationPolicy, type ActivationPolicy, type EventLoopOptions } from "./event-loop";
