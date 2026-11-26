// macOS WKWebView helpers used by ./darwin-tabs (they live here so
// @n1h/sweetview-native stays strictly webview-free).

import { FFIType, JSCallback, dlopen, type Pointer } from "bun:ffi";
import {
  ID,
  NIL,
  type Id,
  asId,
  class_addMethod,
  cstr,
  dataSymbolAddress,
  invokeBlock,
  jsString,
  makeTarget,
  nsString,
  objc_allocateClassPair,
  objc_getClass,
  objc_registerClassPair,
  release,
  retain,
  retainCallback,
  sel,
  send,
  sendIntRetBool,
  sendPtr,
  sendPtrSelPtrPtrVoid,
  sendUIntRetPtr,
} from "@n1h/sweetview-native/darwin/objc";
import { pooled } from "@n1h/sweetview-native/darwin/tabs";
import { pumpEvents } from "@n1h/sweetview-native";
import { scheduleNativeTimeout } from "@n1h/sweetview-native/internal";

/**
 * Finds the WKWebView subview hosted inside an NSWindow's contentView.
 * Matches with `isKindOfClass:` so WKWebView subclasses such as
 * `SweetviewWKWebView` are found, not only views whose class is exactly WKWebView.
 */
export function hostedWebView(window: Id): Id | undefined {
  const wkWebView = asId(objc_getClass(cstr("WKWebView")));
  if (wkWebView === NIL) return undefined;
  const content = asId(send(window, sel("contentView")));
  if (content === NIL) return undefined;
  const views = asId(send(content, sel("subviews")));
  for (let i = 0n, n = BigInt(asId(send(views, sel("count")))); i < n; i++) {
    const view = asId(sendUIntRetPtr(views, sel("objectAtIndex:"), i));
    if (view !== NIL && sendIntRetBool(view, sel("isKindOfClass:"), wkWebView)) return view;
  }
  return undefined;
}

/** Gives first-responder focus to the hosted WKWebView (avoids Tab-focusing the first field). */
export function focusWebView(window: Id): void {
  const webView = hostedWebView(window);
  if (webView !== undefined) sendPtr(window, sel("makeFirstResponder:"), webView);
}

/**
 * Per tab NSWindow state: whether its tab began closing, whether
 * `detachPage` already ran, and the popup timers still queued for it.
 */
type PageState = { closing: boolean; detached: boolean; readonly timers: Set<() => void> };
const pages = new Map<Id, PageState>();
const freshPage = (): PageState => ({ closing: false, detached: false, timers: new Set() });

function pageOf(window: Id): PageState {
  let page = pages.get(window);
  if (page === undefined) pages.set(window, (page = freshPage()));
  return page;
}

/** Starts fresh state for a newly created tab NSWindow (its address may be a closed window's). */
export function openPage(window: Id): void {
  pages.set(window, freshPage());
}

/**
 * Marks the tab as closing and cancels its queued popup openings, so none
 * fires once the tab begins to close. Call it synchronously when a close
 * starts; `detachPage` calls it too.
 */
export function markTabClosing(window: Id): void {
  const page = pages.get(window);
  if (page === undefined) return;
  page.closing = true;
  for (const cancel of page.timers) cancel();
  page.timers.clear();
}

/** Drops the window's state once its tab is gone and its NSWindow closed or discarded. */
export function forgetPage(window: Id): void {
  pages.delete(window);
}

const NSURLErrorCancelled = -999n;
const loadFailureHandlers = new Map<Id, (url: string, reason: string) => void>();
let navigationDelegate: Id | undefined;

const isKindOf = (value: Id, className: string): boolean =>
  value !== NIL && Boolean(sendIntRetBool(value, sel("isKindOfClass:"), asId(objc_getClass(cstr(className)))));

/** The address a navigation failed on: the error's failing URL, else the webview's current URL. */
function failingAddress(view: Id, error: Id): string {
  const info = asId(send(error, sel("userInfo")));
  if (info !== NIL) {
    // NSURLErrorFailingURLStringErrorKey, then NSURLErrorFailingURLErrorKey.
    const text = asId(sendPtr(info, sel("objectForKey:"), nsString("NSErrorFailingURLStringKey")));
    if (isKindOf(text, "NSString")) return jsString(text);
    const url = asId(sendPtr(info, sel("objectForKey:"), nsString("NSErrorFailingURLKey")));
    if (isKindOf(url, "NSURL")) {
      const absolute = asId(send(url, sel("absoluteString")));
      if (absolute !== NIL) return jsString(absolute);
    }
  }
  const current = asId(send(view, sel("URL")));
  const absolute = current === NIL ? NIL : asId(send(current, sel("absoluteString")));
  return absolute === NIL ? "" : jsString(absolute);
}

/** Calls `handler` with the failing address and a readable reason when a navigation of the window's WKWebView fails (cancellations excepted). */
export function onLoadFailed(window: Id, handler: (url: string, reason: string) => void): void {
  pooled(() => {
    const webView = hostedWebView(window);
    if (webView === undefined) return;
    const failed = (view: Id, _navigation: Id, error: Id) => {
      if (BigInt.asIntN(64, asId(send(error, sel("code")))) === NSURLErrorCancelled) return;
      const onFailed = loadFailureHandlers.get(view);
      if (onFailed === undefined) return;
      onFailed(failingAddress(view, error), jsString(asId(send(error, sel("localizedDescription")))));
    };
    navigationDelegate ??= makeTarget("SweetviewTabNavigation", {
      "webView:didFailProvisionalNavigation:withError:": { args: 3, impl: failed },
      "webView:didFailNavigation:withError:": { args: 3, impl: failed },
    });
    loadFailureHandlers.set(webView, handler);
    sendPtr(webView, sel("setNavigationDelegate:"), navigationDelegate);
  });
}

const RUN_OPEN_PANEL = "webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:";
const CREATE_WEB_VIEW = "webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:";

type NewWindowState = {
  readonly handler: (url: string) => void;
  /** The UIDelegate installed before ours (the webview library's), retained until detachPage restores it. */
  readonly previous: Id;
  /** The tab window's state; popup openings are queued on it and cancelled when the tab closes. */
  readonly page: PageState;
};
const newWindowStates = new Map<Id, NewWindowState>();
let uiDelegate: Id | undefined;

/**
 * One shared `SweetviewTabUIDelegate` (an NSObject conforming to WKUIDelegate).
 * It turns HTTP(S) new-window requests into handler calls and forwards file
 * open panels to the webview's previous UIDelegate. A WKWebView holds its
 * UIDelegate weakly; this instance lives for the process.
 */
function tabUIDelegate(): Id {
  if (uiDelegate !== undefined) return uiDelegate;
  const className = "SweetviewTabUIDelegate";
  let klass = asId(objc_getClass(cstr(className)));
  if (klass === NIL) {
    klass = asId(objc_allocateClassPair(asId(objc_getClass(cstr("NSObject"))), cstr(className), 0n));
    if (klass === NIL) throw new Error(`sweetview: objc_allocateClassPair(${className}) failed`);
    const runtime = dlopen("/usr/lib/libobjc.A.dylib", {
      objc_getProtocol: { args: [FFIType.ptr], returns: FFIType.u64 },
      class_addProtocol: { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
    }).symbols;
    const protocol = asId(runtime.objc_getProtocol(cstr("WKUIDelegate")));
    if (protocol !== NIL) runtime.class_addProtocol(klass, protocol);

    const createWebView = new JSCallback(
      (_self: bigint, _cmd: bigint, webView: bigint, _configuration: bigint, action: bigint, _features: bigint): bigint => {
        try {
          const state = newWindowStates.get(asId(webView));
          if (state === undefined || state.page.closing) return NIL;
          const url = asId(send(asId(send(asId(action), sel("request"))), sel("URL")));
          const address = url === NIL ? "" : jsString(asId(send(url, sel("absoluteString"))));
          // Opened after AppKit finishes this delegate call; returning nil tells WebKit not to open a window.
          // markTabClosing cancels it if the tab begins closing first.
          if (/^https?:/i.test(address)) {
            const { page, handler } = state;
            const cancel = scheduleNativeTimeout(1, () => {
              page.timers.delete(cancel);
              if (!page.closing) handler(address);
            });
            page.timers.add(cancel);
          }
        } catch (err) {
          console.error("sweetview: the new-window handler threw:", err);
        }
        return NIL;
      },
      { args: [ID, ID, ID, ID, ID, ID], returns: ID },
    );
    const runOpenPanel = new JSCallback(
      (_self: bigint, _cmd: bigint, webView: bigint, parameters: bigint, frame: bigint, completion: bigint): void => {
        try {
          const previous = newWindowStates.get(asId(webView))?.previous ?? NIL;
          if (previous !== NIL && sendIntRetBool(previous, sel("respondsToSelector:"), sel(RUN_OPEN_PANEL))) {
            sendPtrSelPtrPtrVoid(previous, sel(RUN_OPEN_PANEL), asId(webView), asId(parameters), asId(frame), asId(completion));
          } else {
            // No panel to show: nil tells WebKit the selection was cancelled.
            invokeBlock(asId(completion), [FFIType.u64], 0n);
          }
        } catch (err) {
          console.error("sweetview: the open panel forwarder threw:", err);
        }
      },
      { args: [ID, ID, ID, ID, ID, ID], returns: FFIType.void },
    );
    retainCallback(createWebView);
    retainCallback(runOpenPanel);
    if (!class_addMethod(klass, sel(CREATE_WEB_VIEW), createWebView.ptr, cstr("@@:@@@@"))) {
      throw new Error(`sweetview: class_addMethod(${className}, ${CREATE_WEB_VIEW}) failed`);
    }
    if (!class_addMethod(klass, sel(RUN_OPEN_PANEL), runOpenPanel.ptr, cstr("v@:@@@@"))) {
      throw new Error(`sweetview: class_addMethod(${className}, ${RUN_OPEN_PANEL}) failed`);
    }
    objc_registerClassPair(klass);
  }
  uiDelegate = asId(send(asId(send(klass, sel("alloc"))), sel("init")));
  return uiDelegate;
}

/**
 * Calls `handler` with the address of each HTTP(S) `target="_blank"` link or
 * `window.open()` in the window's WKWebView, instead of opening a window.
 * Other schemes are dropped, as in the Windows driver. `detachPage` puts the
 * previous UIDelegate back.
 */
export function onNewWindowRequested(window: Id, handler: (url: string) => void): void {
  pooled(() => {
    const webView = hostedWebView(window);
    if (webView === undefined) return;
    const delegate = tabUIDelegate();
    const existing = newWindowStates.get(webView);
    if (existing !== undefined) {
      newWindowStates.set(webView, { ...existing, handler });
      return;
    }
    const current = asId(send(webView, sel("UIDelegate")));
    newWindowStates.set(webView, { handler, previous: current === NIL ? NIL : retain(current), page: pageOf(window) });
    sendPtr(webView, sel("setUIDelegate:"), delegate);
  });
}

/** Restores the UIDelegate `onNewWindowRequested` replaced and releases the reference it held. */
function restoreUIDelegate(webView: Id): void {
  const state = newWindowStates.get(webView);
  if (state === undefined) return;
  newWindowStates.delete(webView);
  // The webview library releases whatever UIDelegate is set when it is destroyed, so its own must be back first.
  if (asId(send(webView, sel("UIDelegate"))) === uiDelegate) sendPtr(webView, sel("setUIDelegate:"), state.previous);
  release(state.previous);
}

let dispatchAsyncF:((queue: bigint, ctx: Pointer | null, fn: Pointer | null) => void) | undefined;
let mainQueue: bigint | undefined;

function drainMainQueue(): void {
  dispatchAsyncF ??= dlopen("/usr/lib/libSystem.B.dylib", {
    dispatch_async_f: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  }).symbols.dispatch_async_f as unknown as typeof dispatchAsyncF;
  mainQueue ??= dataSymbolAddress("/usr/lib/system/libdispatch.dylib", "_dispatch_main_q");
  let reached = false;
  const marker = new JSCallback(() => void (reached = true), { args: [FFIType.ptr], returns: FFIType.void });
  dispatchAsyncF!(mainQueue, null, marker.ptr as never);
  for (let i = 0; !reached && i < 1000; i++) pumpEvents();
  if (reached) marker.close();
  else console.error("sweetview: the main queue did not drain");
}

/**
 * Safely detaches the WKWebView before disposing the webview engine so queued
 * script-message replies never run on freed memory, and puts back the
 * UIDelegate the webview library releases on destroy. Idempotent per tab
 * window (until `openPage` starts it again), so both a tab driver and the
 * webview's own `beforeDestroy` hook can call it.
 */
export function detachPage(window: Id): void {
  const page = pageOf(window);
  if (page.detached) return;
  page.detached = true;
  markTabClosing(window);
  pooled(() => {
    const webView = hostedWebView(window);
    if (webView === undefined) return;
    loadFailureHandlers.delete(webView);
    sendPtr(webView, sel("setNavigationDelegate:"), NIL);
    restoreUIDelegate(webView);
    send(asId(send(asId(send(webView, sel("configuration"))), sel("userContentController"))), sel("removeAllScriptMessageHandlers"));
    sendPtr(webView, sel("stopLoading:"), NIL);
    drainMainQueue();
    drainMainQueue();
  });
}
