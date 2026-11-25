// One module per feature. Import what you use.
export { createTray, Tray, type TrayIcon, type TrayOptions } from "./tray";
export { createNotifier, Notifier, type NotificationClick, type NotificationOptions, type NotifierOptions } from "./notifications";
export { Screen, type ScreenInfo } from "./screen";
export {
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
export { Menu, resolveMenu, type MenuItem, type MenuSource, type MenuTemplate } from "./menu";
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
