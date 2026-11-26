// macOS WKWebView helpers used by ./darwin-tabs (they live here so
// @n1h/sweetview-native stays strictly webview-free).

import { FFIType, JSCallback, dlopen, type Pointer } from "bun:ffi";
import {
  NIL,
  type Id,
  asId,
  cstr,
  dataSymbolAddress,
  jsString,
  makeTarget,
  objc_getClass,
  sel,
  send,
  sendIntRetBool,
  sendPtr,
  sendUIntRetPtr,
} from "@n1h/sweetview-native/darwin/objc";
import { pooled } from "@n1h/sweetview-native/darwin/tabs";
import { pumpEvents } from "@n1h/sweetview-native";

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

const NSURLErrorCancelled = -999n;
const loadFailureHandlers = new Map<Id, (reason: string) => void>();
let navigationDelegate: Id | undefined;

export function onLoadFailed(window: Id, handler: (reason: string) => void): void {
  pooled(() => {
    const webView = hostedWebView(window);
    if (webView === undefined) return;
    const failed = (view: Id, _navigation: Id, error: Id) => {
      if (BigInt.asIntN(64, asId(send(error, sel("code")))) === NSURLErrorCancelled) return;
      loadFailureHandlers.get(view)?.(jsString(asId(send(error, sel("localizedDescription")))));
    };
    navigationDelegate ??= makeTarget("SweetviewTabNavigation", {
      "webView:didFailProvisionalNavigation:withError:": { args: 3, impl: failed },
      "webView:didFailNavigation:withError:": { args: 3, impl: failed },
    });
    loadFailureHandlers.set(webView, handler);
    sendPtr(webView, sel("setNavigationDelegate:"), navigationDelegate);
  });
}

let dispatchAsyncF: ((queue: bigint, ctx: Pointer | null, fn: Pointer | null) => void) | undefined;
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
 * script-message replies never run on freed memory.
 */
export function detachPage(window: Id): void {
  pooled(() => {
    const webView = hostedWebView(window);
    if (webView === undefined) return;
    loadFailureHandlers.delete(webView);
    sendPtr(webView, sel("setNavigationDelegate:"), NIL);
    send(asId(send(asId(send(webView, sel("configuration"))), sel("userContentController"))), sel("removeAllScriptMessageHandlers"));
    sendPtr(webView, sel("stopLoading:"), NIL);
    drainMainQueue();
    drainMainQueue();
  });
}
