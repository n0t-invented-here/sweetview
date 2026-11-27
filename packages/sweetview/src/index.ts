// UI-thread entry. The worker entry is "@n1h/sweetview/worker", the page side is
// "@n1h/sweetview/page". The page side pulls in no bun:ffi; the worker dlopens
// the webview library for webview_dispatch but never imports webview-bun.
import "./tabs";
export {
  createApp,
  WebView,
  type App,
  type AppOptions,
  type Asset,
  type Tab,
  type TabOptions,
  type UiMethods,
  type WebViewOptions,
} from "./app";
export { assetMime, indexHtml, indexHtmlText, type IndexHtmlOptions } from "./html";
export {
  windowChromeMethods,
  type WindowChromeInfo,
  type WindowChromeKind,
  type WindowChromeMethodTable,
  type WindowChromeMethods,
  type WindowChromeOptions,
} from "./window-chrome";
export { Ring } from "./ring";
export { ASSET_ORIGIN, FRAMES_ORIGIN } from "./webview-lib";
export type { NativeRequest, NativeResponse } from "./messages";
export {
  pumpEvents,
  quitEventLoop,
  runEventLoop,
  setActivationPolicy,
  type ActivationPolicy,
  type EventLoopOptions,
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
} from "@n1h/sweetview-native";
export { defineAppIdentity, type AppIdentity, type AppIdentityInput } from "@n1h/sweetview-settings";
export { SizeHint, WEBVIEW_VERSION, Webview as RawWebview } from "@n1h/sweetview-webview-bun";
