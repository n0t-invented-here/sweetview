// Webview-free macOS window tabbing primitives (AppKit NSWindow tabbing).
// Uses one shared NSResponder target mapped per window so multiple tab groups
// never leak Objective-C runtime classes. Zero WKWebView imports here.

import type { Appearance, Rect } from "../window";
import {
  NIL,
  type Id,
  alloc,
  allocRaw,
  asId,
  cls,
  makeTarget,
  nsString,
  release,
  retain,
  sel,
  send,
  sendBool,
  sendF64Void,
  sendIntArg,
  sendPtr,
  sendPtrIntVoid,
  sendPtrPtrPtrVoid,
  sendPtrSelPtr,
  sendPtrSelPtrPtrVoid,
  sendRectBool,
  sendRectUIntUIntBool,
  sendRetBool,
  sendSize,
  sendUIntArg,
  sharedApp,
} from "./objc";
import { toCocoa } from "./screen";
import { darwinTabWindowClass, setDarwinTabCloseRequest } from "./window";

const NSWindowStyleMaskTitled = 1n;
const NSWindowStyleMaskClosable = 2n;
const NSWindowStyleMaskMiniaturizable = 4n;
const NSWindowStyleMaskResizable = 8n;
const NSBackingStoreBuffered = 2n;
const NSWindowTabbingModePreferred = 1n;
const NSWindowAbove = 1n;
const NSNormalWindowLevel = 0n;
const NSStatusWindowLevel = 25n;
const NSWindowCollectionBehaviorIgnoresCycle = 1n << 6n;
const NSApplicationActivationPolicyAccessory = 1n;

export type WindowTabsOptions = {
  identifier: string;
  bounds?: Rect;
  width: number;
  height: number;
  /** Minimum outer frame size in points (`NSWindow.setMinSize:`). Default: 480x320. */
  minWidth?: number;
  minHeight?: number;
  appearance?: Appearance;
  /** Allow user resizing (`NSWindowStyleMaskResizable`). Default: true. */
  resizable?: boolean;
  /** Initial window level of tab windows: `NSStatusWindowLevel` when true. Default: false. */
  topmost?: boolean;
  /** Whole-window opacity, 0..1 (`setAlphaValue:`). */
  opacity?: number;
  /** Add `NSWindowCollectionBehaviorIgnoresCycle` and switch the app to the `accessory` activation policy. Default: false. */
  hideFromTaskbar?: boolean;
  /** Show tab windows with `orderFrontRegardless` instead of `makeKeyAndOrderFront:` + `activateIgnoringOtherApps:`. Default: false. */
  noActivate?: boolean;
  onNewTabRequest(): void;
  onSelected?(window: Id): void;
  onResized?(window: Id): void;
  onMoved?(window: Id): void;
  onCloseRequest?(window: Id): boolean;
  /** Called synchronously from `windowWillClose:`, before the deferred `onClosed`. */
  onWillClose?(window: Id): void;
  onClosed(window: Id): void;
};

export type WindowTabs = {
  createWindow(title: string): Id;
  /**
   * Shows a window from `createWindow()`. `anchor` picks where it goes: a
   * shown window of this group tabs it in after that window; `null` (or a
   * window that is not shown) opens it standalone; omitted, it tabs into the
   * group's current window, if any.
   */
  show(window: Id, anchor?: Id | null, beforeShow?: (window: Id) => void): void;
  discard(window: Id): void;
  setTitle(window: Id, title: string): void;
  /** Sets one tab window's level (`NSStatusWindowLevel` / `NSNormalWindowLevel`). */
  setTopmost(window: Id, on: boolean): void;
  /** Sets the level of every tab window in the group, and of tab windows created later. */
  setGroupTopmost(on: boolean): void;
  select(window: Id): void;
  close(window: Id): void;
  moveToNewWindow(window: Id): void;
  mergeAllWindows(): void;
  current(): Id | undefined;
  count(): number;
  dispose(): void;
};

export function pooled<T>(body: () => T): T {
  const pool = alloc("NSAutoreleasePool");
  try {
    return body();
  } finally {
    send(pool, sel("drain"));
  }
}

const notifications = () => asId(send(cls("NSNotificationCenter"), sel("defaultCenter")));

type GroupHooks = {
  onNewTab: () => void;
  onWillClose: (window: Id) => void;
  onDidBecomeMain: (window: Id) => void;
  onDidResize: (window: Id) => void;
  onDidMove: (window: Id) => void;
};

const hooksByWindow = new Map<Id, GroupHooks>();
let sharedResponder: Id | undefined;
let lastActiveGroup: GroupHooks | undefined;

function ensureResponder(): Id {
  sharedResponder ??= makeTarget(
    "SweetviewWindowTabs",
    {
      "newWindowForTab:": (sender) => {
        // sender is usually the window or menu item; check keyWindow first, fall back to lastActiveGroup.
        const app = sharedApp();
        const key = asId(send(app, sel("keyWindow")));
        const hooks = hooksByWindow.get(sender) ?? hooksByWindow.get(key) ?? lastActiveGroup;
        hooks?.onNewTab();
      },
      "tabWindowWillClose:": (notification) => {
        const win = asId(send(notification, sel("object")));
        hooksByWindow.get(win)?.onWillClose(win);
      },
      "tabWindowDidBecomeMain:": (notification) => {
        const win = asId(send(notification, sel("object")));
        const hooks = hooksByWindow.get(win);
        if (hooks) {
          lastActiveGroup = hooks;
          hooks.onDidBecomeMain(win);
        }
      },
      "tabWindowDidResize:": (notification) => {
        const win = asId(send(notification, sel("object")));
        hooksByWindow.get(win)?.onDidResize(win);
      },
      "tabWindowDidMove:": (notification) => {
        const win = asId(send(notification, sel("object")));
        hooksByWindow.get(win)?.onDidMove(win);
      },
    },
    "NSResponder",
  );
  return sharedResponder;
}

const OBSERVED: [name: string, selector: string][] = [
  ["NSWindowWillCloseNotification", "tabWindowWillClose:"],
  ["NSWindowDidBecomeMainNotification", "tabWindowDidBecomeMain:"],
  ["NSWindowDidResizeNotification", "tabWindowDidResize:"],
  ["NSWindowDidMoveNotification", "tabWindowDidMove:"],
];

export function createWindowTabs(options: WindowTabsOptions): WindowTabs {
  const app = sharedApp();
  const identifier = retain(nsString(options.identifier));
  const shown = new Set<Id>();
  const hidden = new Set<Id>();
  const responder = ensureResponder();
  let disposed = false;
  let topmost = options.topmost ?? false;
  const noActivate = options.noActivate ?? false;
  // The tab last selected, shown, or made main. Under noActivate no tab becomes
  // key, so current() cannot rely on keyWindow and uses this tab's group instead.
  let lastSelected: Id | undefined;
  const groupOf = (window: Id): Id => asId(send(window, sel("tabGroup")));
  const applyLevel = (window: Id, on: boolean) => sendIntArg(window, sel("setLevel:"), on ? NSStatusWindowLevel : NSNormalWindowLevel);

  const keepTabBar = (window: Id) => {
    if (!shown.has(window)) return;
    const group = asId(send(window, sel("tabGroup")));
    if (group !== NIL && !sendRetBool(group, sel("isTabBarVisible"))) sendPtr(window, sel("toggleTabBar:"), NIL);
  };

  const stopObserving = (window: Id) => {
    hooksByWindow.delete(window);
    setDarwinTabCloseRequest(window, undefined);
    for (const [name] of OBSERVED) {
      sendPtrPtrPtrVoid(notifications(), sel("removeObserver:name:object:"), responder, nsString(name), window);
    }
  };

  const hooks: GroupHooks = {
    onNewTab: () => {
      if (!disposed) options.onNewTabRequest();
    },
    onWillClose: (window) => {
      if (!shown.delete(window)) return;
      try {
        options.onWillClose?.(window);
      } catch (err) {
        console.error("sweetview: a tab window's onWillClose threw:", err);
      }
      if (lastSelected === window) {
        // Advance to another live tab in the same group (or none; current() falls back).
        const group = groupOf(window);
        lastSelected = group === NIL ? undefined : [...shown].findLast((w) => groupOf(w) === group);
      }
      stopObserving(window);
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
    },
    onDidBecomeMain: (window) => {
      if (disposed || !shown.has(window)) return;
      lastSelected = window;
      options.onSelected?.(window);
      setTimeout(() => pooled(() => keepTabBar(window)), 0);
    },
    onDidResize: (window) => {
      if (disposed || !shown.has(window)) return;
      options.onResized?.(window);
    },
    onDidMove: (window) => {
      if (disposed || !shown.has(window)) return;
      options.onMoved?.(window);
    },
  };
  lastActiveGroup = hooks;

  const observe = (window: Id) => {
    hooksByWindow.set(window, hooks);
    if (options.onCloseRequest) setDarwinTabCloseRequest(window, () => options.onCloseRequest!(window));
    for (const [name, selector] of OBSERVED) {
      sendPtrSelPtrPtrVoid(notifications(), sel("addObserver:selector:name:object:"), responder, sel(selector), nsString(name), window);
    }
  };

  const current = (): Id | undefined => {
    const key = asId(send(app, sel("keyWindow")));
    if (shown.has(key)) return key;
    // No tab is key (e.g. noActivate, or the app is inactive): ask the tab group
    // of the last selected tab (else the last shown tab) which tab it shows.
    const anchor = lastSelected !== undefined && shown.has(lastSelected) ? lastSelected : [...shown].at(-1);
    if (anchor === undefined) return undefined;
    const group = groupOf(anchor);
    if (group !== NIL) {
      const selected = asId(send(group, sel("selectedWindow")));
      if (shown.has(selected)) return selected;
    }
    return anchor;
  };

  return {
    createWindow: (title) =>
      pooled(() => {
        let style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
        if (options.resizable !== false) style |= NSWindowStyleMaskResizable;
        const c = options.bounds ? toCocoa(options.bounds) : { x: 0, y: 0, w: options.width, h: options.height };
        const window = asId(
          sendRectUIntUIntBool(asId(send(darwinTabWindowClass(), sel("alloc"))), sel("initWithContentRect:styleMask:backing:defer:"), c.x, c.y, c.w, c.h, style, NSBackingStoreBuffered, false),
        );
        if (window === NIL) throw new Error("sweetview: NSWindow init failed");
        sendBool(window, sel("setReleasedWhenClosed:"), false);
        if (options.bounds) sendRectBool(window, sel("setFrame:display:"), c.x, c.y, c.w, c.h, false);
        sendPtr(window, sel("setTitle:"), nsString(title));
        // setMinSize: is the outer frame size in points, matching the WindowOptions outer-frame contract.
        sendSize(window, sel("setMinSize:"), options.minWidth ?? 480, options.minHeight ?? 320);
        if (options.opacity !== undefined) sendF64Void(window, sel("setAlphaValue:"), Math.min(1, Math.max(0, options.opacity)));
        if (topmost) applyLevel(window, true);
        if (options.hideFromTaskbar) {
          sendUIntArg(window, sel("setCollectionBehavior:"), NSWindowCollectionBehaviorIgnoresCycle);
          sendIntArg(app, sel("setActivationPolicy:"), NSApplicationActivationPolicyAccessory);
        }
        if (options.appearance && options.appearance !== "system") {
          const name = options.appearance === "dark" ? "NSAppearanceNameDarkAqua" : "NSAppearanceNameAqua";
          sendPtr(window, sel("setAppearance:"), asId(sendPtr(cls("NSAppearance"), sel("appearanceNamed:"), nsString(name))));
        }
        sendPtr(window, sel("setTabbingIdentifier:"), identifier);
        sendIntArg(window, sel("setTabbingMode:"), NSWindowTabbingModePreferred);
        sendPtr(window, sel("setNextResponder:"), responder);
        observe(window);
        hidden.add(window);
        return window;
      }),
    show: (window, after, beforeShow) =>
      pooled(() => {
        if (!hidden.delete(window)) throw new Error("sweetview: show() takes a window from createWindow(), once");
        const anchor = after === undefined ? current() : after !== null && shown.has(after) ? after : undefined;
        shown.add(window);
        lastSelected = window;
        beforeShow?.(window);
        if (anchor === undefined && !options.bounds) send(window, sel("center"));
        else if (anchor !== undefined) sendPtrIntVoid(anchor, sel("addTabbedWindow:ordered:"), window, NSWindowAbove);
        if (noActivate) {
          send(window, sel("orderFrontRegardless"));
        } else {
          sendPtr(window, sel("makeKeyAndOrderFront:"), NIL);
          sendBool(app, sel("activateIgnoringOtherApps:"), true);
        }
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
    setTopmost: (window, on) =>
      pooled(() => {
        if (shown.has(window) || hidden.has(window)) applyLevel(window, on);
      }),
    setGroupTopmost: (on) =>
      pooled(() => {
        topmost = on;
        for (const window of [...shown, ...hidden]) applyLevel(window, on);
      }),
    select: (window) =>
      pooled(() => {
        if (!shown.has(window)) return;
        lastSelected = window;
        if (noActivate) {
          // Select the tab and bring it forward without taking key focus or activating the app.
          const group = groupOf(window);
          if (group !== NIL) sendPtr(group, sel("setSelectedWindow:"), window);
          send(window, sel("orderFrontRegardless"));
        } else {
          sendPtr(window, sel("makeKeyAndOrderFront:"), NIL);
        }
      }),
    close: (window) =>
      pooled(() => {
        if (shown.has(window)) sendPtr(window, sel("performClose:"), NIL);
      }),
    moveToNewWindow: (window) =>
      pooled(() => {
        if (shown.has(window)) sendPtr(window, sel("moveTabToNewWindow:"), NIL);
      }),
    mergeAllWindows: () =>
      pooled(() => {
        const cur = current();
        if (cur !== undefined) sendPtr(cur, sel("mergeAllWindows:"), NIL);
      }),
    current: () => pooled(current),
    count: () => shown.size,
    dispose: () =>
      pooled(() => {
        if (disposed) return;
        disposed = true;
        lastSelected = undefined;
        if (lastActiveGroup === hooks) lastActiveGroup = undefined;
        for (const w of [...hidden]) {
          hidden.delete(w);
          stopObserving(w);
          release(w);
        }
        for (const w of [...shown]) {
          shown.delete(w);
          stopObserving(w);
          sendPtr(w, sel("orderOut:"), NIL);
          send(w, sel("close"));
          release(w);
        }
        release(identifier);
      }),
  };
}

const SHIFT = 1n << 17n;
const CONTROL = 1n << 18n;
const COMMAND = 1n << 20n;

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
    release(menuItem);
  }
  const holder = alloc("NSMenuItem");
  sendPtr(holder, sel("setSubmenu:"), menu);
  if (index === undefined) sendPtr(menubar, sel("addItem:"), holder);
  else sendPtrIntVoid(menubar, sel("insertItem:atIndex:"), holder, BigInt(index));
  release(holder);
  release(menu);
  return menu;
}

let installedMenuBar: Id = NIL;

/** Adds File (New/Close Tab), View (Show All Tabs), and Window tab menus to the macOS mainMenu (once per menu bar). */
export function installTabMenus(): void {
  const app = sharedApp();
  const menubar = asId(send(app, sel("mainMenu")));
  if (menubar === NIL || installedMenuBar === menubar) return;
  installedMenuBar = menubar;
  addMenu(
    menubar,
    "File",
    [
      ["New Tab", "newWindowForTab:", "t"],
      ["Close Tab", "performClose:", "w"],
    ],
    1,
  );
  addMenu(menubar, "View", [["Show All Tabs", "toggleTabOverview:", "\\", COMMAND | SHIFT]]);
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
