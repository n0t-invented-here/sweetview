// UI-thread entry. The worker entry is "@n1h/sweetview/worker", the page side is
// "@n1h/sweetview/page". The page side pulls in no native code; the worker loads
// the native binding only to wake this thread.
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
  windowChromeEvents,
  windowChromeMethods,
  type WindowChromeEvents,
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
  onCallbackError,
  type CallbackErrorHandler,
  type CallbackErrorSource,
  type CallbackKind,
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
export { RawWebview, SizeHint, WEBVIEW_VERSION } from "@n1h/sweetview-native";
