// Menu bar status item (NSStatusItem). Uses one shared ObjC target per process
// mapped by status-bar button so creating and disposing multiple trays never
// leaks Objective-C classes or callbacks.

import { resolveMenu, type MenuSource } from "../menu";
import type { CallbackKind } from "../callback-errors";
import type { TrayBackend, TrayIcon, TrayOptions } from "../tray";
import { applyImage, makeImage } from "./image";
import { type BuiltMenu, buildMenu } from "./menu";
import {
  NIL,
  type Id,
  asId,
  cls,
  makeTarget,
  nsString,
  release,
  retain,
  sel,
  send,
  sendF64,
  sendInt,
  sendPtr,
  sendPtrSelPtrVoid,
  sendRetF64,
  sendSelPtrF64,
  sendUInt,
  sharedApp,
} from "./objc";

const NSVariableStatusItemLength = -1;
const NSEventTypeLeftMouseUp = 2n;
const NSEventTypeRightMouseUp = 4n;
const NSEventMaskLeftMouseUp = 1n << NSEventTypeLeftMouseUp;
const NSEventMaskRightMouseUp = 1n << NSEventTypeRightMouseUp;
const NSEventModifierFlagControl = 1n << 18n;

/** Menu bar images are 18x18 points; the PNG's pixels (36 for Retina) are mapped onto that. */
const MENU_BAR_POINTS = 18;

type TrayDispatch = {
  onAction: () => void;
  onSingleClick: () => void;
};

const traysByButton = new Map<Id, TrayDispatch>();
/** What `trayAction:` was running when it threw: the menu function, or the double-click handler. */
let trayActionKind: CallbackKind = "tray.menu";
let sharedTarget: Id | undefined;

function trayTarget(): Id {
  sharedTarget ??= makeTarget(
    "SweetviewTrayTarget",
    {
      "trayAction:": (sender) => traysByButton.get(sender)?.onAction(),
      "traySingleClick:": (sender) => traysByButton.get(sender)?.onSingleClick(),
    },
    "NSObject",
    { "trayAction:": () => trayActionKind, "traySingleClick:": "tray.onClick" },
  );
  return sharedTarget;
}

export function createTray(options: TrayOptions): TrayBackend {
  sharedApp();
  const statusBar = asId(send(cls("NSStatusBar"), sel("systemStatusBar")));
  // statusItemWithLength: returns +0; keep our own reference until dispose.
  const item = retain(asId(sendF64(statusBar, sel("statusItemWithLength:"), NSVariableStatusItemLength)));
  if (item === NIL) throw new Error("sweetview: NSStatusBar.statusItemWithLength: returned nil");
  const button = asId(send(item, sel("button")));

  let menu: MenuSource | undefined = options.menu;
  let built: BuiltMenu | undefined;
  let disposed = false;

  const applyIcon = (icon: TrayIcon | undefined) => {
    const made = makeImage(icon?.macos, MENU_BAR_POINTS);
    applyImage(button, "setImage:", made);
    sendPtr(button, sel("setTitle:"), nsString(made.img === NIL ? "●" : ""));
  };

  const showMenu = () => {
    if (menu === undefined) return;
    const template = resolveMenu(menu);
    if (template.length === 0) return;
    const previous = built;
    built = buildMenu(template);
    sendPtr(item, sel("setMenu:"), built.menu);
    sendPtr(button, sel("performClick:"), NIL); // tracks the menu modally
    sendPtr(item, sel("setMenu:"), NIL);
    previous?.dispose();
  };

  const target = trayTarget();
  traysByButton.set(button, {
    onAction: () => {
      const event = asId(send(sharedApp(), sel("currentEvent")));
      if (event === NIL) return;
      const type = BigInt(sendInt(event, sel("type")) ?? 0);
      const control = (BigInt(sendInt(event, sel("modifierFlags")) ?? 0) & NSEventModifierFlagControl) !== 0n;
      // macOS convention: a menu bar item's menu opens on any click.
      if (menu !== undefined || type === NSEventTypeRightMouseUp || (type === NSEventTypeLeftMouseUp && control)) {
        trayActionKind = "tray.menu";
        showMenu();
        return;
      }
      if (type !== NSEventTypeLeftMouseUp) return;
      const clicks = BigInt(sendInt(event, sel("clickCount")) ?? 1);
      if (clicks >= 2n) {
        sendPtrSelPtrVoid(cls("NSObject"), sel("cancelPreviousPerformRequestsWithTarget:selector:object:"), target, sel("traySingleClick:"), button);
        trayActionKind = "tray.onDoubleClick";
        options.onDoubleClick?.();
      } else if (options.onClick) {
        const delay = Number(sendRetF64(cls("NSEvent"), sel("doubleClickInterval")) ?? 0.3);
        sendSelPtrF64(target, sel("performSelector:withObject:afterDelay:"), sel("traySingleClick:"), button, delay);
      }
    },
    onSingleClick: () => {
      if (!disposed) options.onClick?.();
    },
  });

  applyIcon(options.icon);
  if (options.tooltip) sendPtr(button, sel("setToolTip:"), nsString(options.tooltip));
  sendPtr(button, sel("setTarget:"), target);
  sendPtr(button, sel("setAction:"), sel("trayAction:"));
  sendUInt(button, sel("sendActionOn:"), NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp);

  return {
    setTooltip(text) {
      if (!disposed) sendPtr(button, sel("setToolTip:"), nsString(text));
    },
    setIcon(icon) {
      if (!disposed) applyIcon(icon);
    },
    setMenu(next) {
      menu = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      traysByButton.delete(button);
      sendPtrSelPtrVoid(cls("NSObject"), sel("cancelPreviousPerformRequestsWithTarget:selector:object:"), target, sel("traySingleClick:"), button);
      sendPtr(statusBar, sel("removeStatusItem:"), item);
      release(item);
      built?.dispose();
      built = undefined;
    },
  };
}
