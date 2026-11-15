// macOS window tabs: the tab bar AppKit gives every app (Finder, Terminal,
// Safari's cousin), where a tab *is* an NSWindow. Windows that share a tabbing
// identifier can sit in one frame behind one tab bar; AppKit draws the bar,
// reorders by drag, tears a tab off into its own window and merges it back.
//
// So one webview per tab needs nothing clever: each tab is a framed window of
// our own, handed to `createWebviewApp({ window })` as the host. This module
// makes those windows, joins them, and reports the two things only AppKit
// knows: the user asked for a new tab (the "+" in the tab bar, or anything
// sending `newWindowForTab:`), and a tab's window closed.
//
// macOS only, and demo-local on purpose: Windows has no window tabbing to map
// this onto, so what the cross-platform API should look like is still open.

import { FFIType, JSCallback, dlopen } from "bun:ffi";
import { pumpEvents, type WindowHandle } from "@n1h/sweetview/native";
import {
  NIL,
  type Id,
  alloc,
  allocRaw,
  asId,
  cls,
  dataSymbolAddress,
  jsString,
  makeTarget,
  nsString,
  release,
  retain,
  sel,
  send,
  sendBool,
  sendIntArg,
  sendPtr,
  sendPtrIntVoid,
  sendPtrPtrPtr,
  sendPtrSelPtr,
  sendPtrSelPtrPtrVoid,
  sendRectUIntUIntBool,
  sendRetBool,
  sendSize,
  sendUIntArg,
  sendUIntRetPtr,
  sharedApp,
} from "../../src/native/darwin/objc";

const NSWindowStyleMaskTitled = 1n;
const NSWindowStyleMaskClosable = 2n;
const NSWindowStyleMaskMiniaturizable = 4n;
const NSWindowStyleMaskResizable = 8n;
const NSBackingStoreBuffered = 2n;
const NSWindowTabbingModePreferred = 1n;
const NSWindowAbove = 1n;

export type WindowTabsOptions = {
  /** Windows with the same identifier may share a tab bar; one per kind of window. */
  identifier: string;
  /** Content size of the first window, in points. Later tabs take the size of the window they join. */
  width: number;
  height: number;
  /** The smallest content size the user can drag a window to. */
  minWidth?: number;
  minHeight?: number;
  /** The user asked for a tab: the "+" in the tab bar, or a `newWindowForTab:` from a menu item. */
  onNewTabRequest(): void;
  /**
   * A tab's window closed (its close button, Cmd+W, `close`). Called on a
   * later turn of the event loop, never from inside AppKit's close: the place
   * to `detachPage` and dispose the webview. The window is released after this returns.
   */
  onClosed(window: Id): void;
};

export type WindowTabs = {
  /** A framed window, hidden, already set up as a tab of this group. Put the page in it, then `show` it. */
  createWindow(title: string): Id;
  /**
   * Shows a window made by `createWindow`. The group's first window appears as
   * a plain window; any later one joins the tab bar right after `after`
   * (default: the tab the user is on) and becomes the selected tab. The tab
   * bar is kept visible even with one tab, so the + is always there.
   */
  show(window: Id, after?: Id): void;
  /** Gives up a window from `createWindow` that was never shown (its page failed to load). */
  discard(window: Id): void;
  setTitle(window: Id, title: string): void;
  /** Makes a shown tab the selected one and brings its window forward. */
  select(window: Id): void;
  /** As the tab's close button does. */
  close(window: Id): void;
  /** The tab the user is on: the key window when it is one of ours, else the one shown last. */
  current(): Id | undefined;
  /** How many tabs are open, across however many windows the user has dragged them into. */
  count(): number;
};

/**
 * Runs `body` inside an autorelease pool of its own. The OS loop is pumped
 * from a Bun timer here, and only the pump has a pool: a native call made
 * from any other turn of Bun's loop (a timer, the code after an `await`)
 * autoreleases into nothing, and what it autoreleased is never freed. That
 * kept every closed tab's NSWindow alive.
 */
export function pooled<T>(body: () => T): T {
  const pool = alloc("NSAutoreleasePool");
  try {
    return body();
  } finally {
    send(pool, sel("drain"));
  }
}

/** The handle to give `createWebviewApp({ window })`. */
export const asWindowHandle = (window: Id): WindowHandle => window;

export function createWindowTabs(options: WindowTabsOptions): WindowTabs {
  const app = sharedApp();
  const identifier = retain(nsString(options.identifier)); // kept for every window this group makes
  const shown = new Set<Id>(); // open tabs, in the order they were shown
  const hidden = new Set<Id>(); // created, not yet shown

  const closed = (window: Id) => {
    if (!shown.delete(window)) return;
    stopObserving(window);
    // AppKit is still inside the close; let it finish before the owner tears the page down.
    setTimeout(
      () =>
        pooled(() => {
          try {
            options.onClosed(window);
          } finally {
            release(window);
          }
        }),
      0,
    );
  };

  // AppKit hides the tab bar of a window with one tab, and the + with it. Here the bar is the
  // point, so a window of ours that has none gets it back: when shown, and when a tab becomes
  // a window of its own (torn off, or the last one left).
  const keepTabBar = (window: Id) => {
    if (!shown.has(window)) return;
    const group = asId(send(window, sel("tabGroup")));
    if (group !== NIL && !sendRetBool(group, sel("isTabBarVisible"))) sendPtr(window, sel("toggleTabBar:"), NIL);
  };

  // An NSResponder, so it can be each window's nextResponder. That is the slot
  // a window controller normally fills, and it is where AppKit looks for
  // `newWindowForTab:`; finding it there is what makes the "+" appear.
  const target = makeTarget(
    "SweetviewWindowTabs",
    {
      "newWindowForTab:": () => options.onNewTabRequest(),
      "tabWindowWillClose:": (notification) => closed(asId(send(notification, sel("object")))),
      "tabWindowDidBecomeMain:": (notification) => {
        const window = asId(send(notification, sel("object")));
        setTimeout(() => pooled(() => keepTabBar(window)), 0); // once AppKit has finished moving the tab
      },
    },
    "NSResponder",
  );

  const observed: [name: string, selector: string][] = [
    ["NSWindowWillCloseNotification", "tabWindowWillClose:"],
    ["NSWindowDidBecomeMainNotification", "tabWindowDidBecomeMain:"],
  ];
  const observe = (window: Id) => {
    for (const [name, selector] of observed) sendPtrSelPtrPtrVoid(notifications(), sel("addObserver:selector:name:object:"), target, sel(selector), nsString(name), window);
  };
  const stopObserving = (window: Id) => {
    for (const [name] of observed) sendPtrPtrPtr(notifications(), sel("removeObserver:name:object:"), target, nsString(name), window);
  };

  const current = (): Id | undefined => {
    const key = asId(send(app, sel("keyWindow")));
    if (shown.has(key)) return key;
    return [...shown].at(-1);
  };

  // Every method may be called from outside the pump, so each brings its own pool.
  return {
    createWindow: (title) =>
      pooled(() => {
        const style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
        const window = asId(
          sendRectUIntUIntBool(allocRaw("NSWindow"), sel("initWithContentRect:styleMask:backing:defer:"), 0, 0, options.width, options.height, style, NSBackingStoreBuffered, false),
        );
        if (window === NIL) throw new Error("native-tabs: NSWindow init failed");
        sendBool(window, sel("setReleasedWhenClosed:"), false); // ours to release, after onClosed
        sendPtr(window, sel("setTitle:"), nsString(title));
        sendSize(window, sel("setContentMinSize:"), options.minWidth ?? 480, options.minHeight ?? 320);
        sendPtr(window, sel("setTabbingIdentifier:"), identifier);
        sendIntArg(window, sel("setTabbingMode:"), NSWindowTabbingModePreferred);
        sendPtr(window, sel("setNextResponder:"), target);
        observe(window);
        hidden.add(window);
        return window;
      }),
    show: (window, after) =>
      pooled(() => {
        if (!hidden.delete(window)) throw new Error("native-tabs: show() takes a window from createWindow(), once");
        const anchor = after !== undefined && shown.has(after) ? after : current();
        shown.add(window);
        // Keyboard focus goes to the page as a whole. Left to pick for itself, AppKit reaches the web view
        // through the key-view loop, which WebKit takes as arriving by Tab and answers by focusing the page's first field.
        const webView = hostedWebView(window);
        if (webView !== undefined) sendPtr(window, sel("makeFirstResponder:"), webView);
        if (anchor === undefined) send(window, sel("center"));
        else sendPtrIntVoid(anchor, sel("addTabbedWindow:ordered:"), window, NSWindowAbove);
        sendPtr(window, sel("makeKeyAndOrderFront:"), NIL);
        sendBool(app, sel("activateIgnoringOtherApps:"), true);
        keepTabBar(window);
      }),
    discard: (window) =>
      pooled(() => {
        if (!hidden.delete(window)) return;
        stopObserving(window);
        release(window);
      }),
    setTitle: (window, title) =>
      pooled(() => {
        if (shown.has(window) || hidden.has(window)) sendPtr(window, sel("setTitle:"), nsString(title));
      }),
    select: (window) =>
      pooled(() => {
        if (shown.has(window)) sendPtr(window, sel("makeKeyAndOrderFront:"), NIL);
      }),
    close: (window) =>
      pooled(() => {
        if (shown.has(window)) sendPtr(window, sel("performClose:"), NIL);
      }),
    current: () => pooled(current),
    count: () => shown.size,
  };
}

const notifications = () => asId(send(cls("NSNotificationCenter"), sel("defaultCenter")));

/** The WKWebView the webview library put in a window: a subview of the container it makes the content view (the inspector, when open, is its sibling). */
function hostedWebView(window: Id): Id | undefined {
  const content = asId(send(window, sel("contentView")));
  if (content === NIL) return undefined;
  const views = asId(send(content, sel("subviews")));
  for (let i = 0n, n = BigInt(asId(send(views, sel("count")))); i < n; i++) {
    const view = asId(sendUIntRetPtr(views, sel("objectAtIndex:"), i));
    if (jsString(asId(send(view, sel("className")))) === "WKWebView") return view;
  }
  return undefined;
}

const NSURLErrorCancelled = -999n; // a load we stopped ourselves, or one a newer load replaced
const loadFailureHandlers = new Map<Id, (reason: string) => void>(); // by WKWebView
let navigationDelegate: Id | undefined;

/**
 * Calls `handler` with the system's own sentence ("A server with the
 * specified hostname could not be found.") when the page hosted in a window
 * fails to load. Without it a site that cannot be reached is a blank page.
 * The webview library sets no navigation delegate, so the slot is free.
 */
export function onLoadFailed(window: Id, handler: (reason: string) => void): void {
  pooled(() => {
    const webView = hostedWebView(window);
    if (webView === undefined) throw new Error("native-tabs: onLoadFailed() needs a window that hosts a webview");
    const failed = (view: Id, _navigation: Id, error: Id) => {
      if (BigInt.asIntN(64, asId(send(error, sel("code")))) === NSURLErrorCancelled) return;
      loadFailureHandlers.get(view)?.(jsString(asId(send(error, sel("localizedDescription")))));
    };
    navigationDelegate ??= makeTarget("SweetviewTabNavigation", {
      "webView:didFailProvisionalNavigation:withError:": { args: 3, impl: failed }, // never reached the server
      "webView:didFailNavigation:withError:": { args: 3, impl: failed }, // broke off part-way
    });
    loadFailureHandlers.set(webView, handler);
    sendPtr(webView, sel("setNavigationDelegate:"), navigationDelegate);
  });
}

const { dispatch_async_f } = dlopen("/usr/lib/libSystem.B.dylib", {
  dispatch_async_f: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.void }, // (queue, context, void (*)(void *))
}).symbols;
let mainQueue: bigint | undefined; // dispatch_get_main_queue() is a macro for the address of this object

/** Runs the OS loop until everything already queued for the main thread has run. Not for use inside an AppKit callback. */
function drainMainQueue(): void {
  mainQueue ??= dataSymbolAddress("/usr/lib/system/libdispatch.dylib", "_dispatch_main_q");
  let reached = false;
  const marker = new JSCallback(() => void (reached = true), { args: [FFIType.ptr], returns: FFIType.void });
  dispatch_async_f(mainQueue, null, marker.ptr); // the queue is first in, first out: when this runs, all that was ahead of it has
  for (let i = 0; !reached && i < 1000; i++) pumpEvents();
  if (reached) marker.close();
  else console.error("native-tabs: the main queue did not drain"); // the marker stays allocated: the queue may still call it
}

/**
 * Makes the webview hosted in a window safe to dispose: cuts its page off
 * from native code, then lets what was already on its way arrive.
 *
 * The webview library hands two things to the main dispatch queue with a
 * plain pointer to its engine inside: each call from the page, and each reply
 * to one. For a window of its own it flushes that queue as it is destroyed;
 * for a hosted window it does not, so a reply still queued (to the very
 * "close this tab" call that got us here) would run on freed memory and take
 * the process down. So: no new calls (the page loses its message handlers
 * and stops loading), one drain for the calls already queued, one more for
 * the replies those calls queue.
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

const SHIFT = 1n << 17n; // NSEventModifierFlagShift
const CONTROL = 1n << 18n;
const COMMAND = 1n << 20n;

/** `modifiers` replaces the Command a key equivalent implies (a capital letter still adds Shift by itself). */
type MenuItem = [title: string, action: string, key: string, modifiers?: bigint] | "separator";

function addMenu(menubar: Id, title: string, items: MenuItem[], index?: number): Id {
  const menu = asId(sendPtr(allocRaw("NSMenu"), sel("initWithTitle:"), nsString(title)));
  for (const item of items) {
    if (item === "separator") {
      sendPtr(menu, sel("addItem:"), asId(send(cls("NSMenuItem"), sel("separatorItem"))));
      continue;
    }
    const [itemTitle, action, key, modifiers] = item;
    const menuItem = asId(sendPtrSelPtr(allocRaw("NSMenuItem"), sel("initWithTitle:action:keyEquivalent:"), nsString(itemTitle), sel(action), nsString(key)));
    if (modifiers !== undefined) sendUIntArg(menuItem, sel("setKeyEquivalentModifierMask:"), modifiers);
    sendPtr(menu, sel("addItem:"), menuItem);
    release(menuItem); // the menu retains it
  }
  const holder = alloc("NSMenuItem");
  sendPtr(holder, sel("setSubmenu:"), menu);
  if (index === undefined) sendPtr(menubar, sel("addItem:"), holder);
  else sendPtrIntVoid(menubar, sel("insertItem:atIndex:"), holder, BigInt(index));
  release(holder); // the menu bar retains it
  release(menu); // the holder retains it
  return menu;
}

/**
 * The menus a tabbed app has, added to the menu bar `installAppMenu` made
 * (call that first): File with New Tab and Close Tab, View with the tab
 * overview, and Window with the tab commands and, below them, the
 * list of windows AppKit keeps once the menu is its windows menu. Every item
 * has no target, so it goes down the responder chain to the window the user
 * is in; all but New Tab are NSWindow's own actions, and AppKit greys out the
 * ones that do not apply (Merge All Windows with one window).
 */
export function installTabMenus(): void {
  const app = sharedApp();
  const menubar = asId(send(app, sel("mainMenu")));
  if (menubar === NIL) throw new Error("native-tabs: no main menu; call installAppMenu first");
  addMenu(
    menubar,
    "File",
    [
      ["New Tab", "newWindowForTab:", "t"],
      ["Close Tab", "performClose:", "w"],
    ],
    1, // right after the app menu
  );
  addMenu(menubar, "View", [["Show All Tabs", "toggleTabOverview:", "\\", COMMAND | SHIFT]]); // no Show Tab Bar: it is always shown
  const windowMenu = addMenu(menubar, "Window", [
    ["Minimize", "performMiniaturize:", "m"],
    ["Zoom", "performZoom:", ""],
    "separator",
    ["Show Previous Tab", "selectPreviousTab:", "\t", CONTROL | SHIFT],
    ["Show Next Tab", "selectNextTab:", "\t", CONTROL],
    ["Move Tab to New Window", "moveTabToNewWindow:", ""],
    ["Merge All Windows", "mergeAllWindows:", ""],
  ]);
  sendPtr(app, sel("setWindowsMenu:"), windowMenu);
}
