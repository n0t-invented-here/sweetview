// Menu bar status item (NSStatusItem). As on every Mac menu bar item, any
// click (left, right, ctrl+click) opens the menu when there is one. Only when
// no menu is set do clicks reach the app: left double click fires
// onDoubleClick; a left click not followed by a second within
// NSEvent.doubleClickInterval fires onClick. That delay runs on the Cocoa run
// loop (performSelector:withObject:afterDelay:), not on a JS timer, because
// Bun's loop is blocked while the webview runs.
//
// The menu is attached only for the duration of the click (setMenu:,
// performClick:, setMenu:nil) so it is rebuilt from current state each time.

import { resolveMenu, type MenuSource } from "../menu";
import type { Tray, TrayIcon, TrayOptions } from "../tray";
import { applyImage, makeImage } from "./image";
import { type BuiltMenu, buildMenu } from "./menu";
import {
  NIL,
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

let nextUid = 1;

/** Menu bar images are 18x18 points; the PNG's pixels (36 for Retina) are mapped onto that. */
const MENU_BAR_POINTS = 18;

export function createTray(options: TrayOptions): Tray {
  const uid = nextUid++;
  const statusBar = asId(send(cls("NSStatusBar"), sel("systemStatusBar")));
  // statusItemWithLength: returns +0; keep our own reference until dispose.
  const item = retain(asId(sendF64(statusBar, sel("statusItemWithLength:"), NSVariableStatusItemLength)));
  if (item === NIL) throw new Error("sweetnative: NSStatusBar.statusItemWithLength: returned nil");
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
    // The chosen item's action has already fired; the old menu can go now.
    previous?.dispose();
  };

  const target = makeTarget(`NativeShellTrayTarget${uid}`, {
    "trayAction:": () => {
      const event = asId(send(sharedApp(), sel("currentEvent")));
      if (event === NIL) return;
      const type = BigInt(sendInt(event, sel("type")) ?? 0);
      const control = (BigInt(sendInt(event, sel("modifierFlags")) ?? 0) & NSEventModifierFlagControl) !== 0n;
      // macOS convention: a menu bar item's menu opens on any click.
      if (menu !== undefined || type === NSEventTypeRightMouseUp || (type === NSEventTypeLeftMouseUp && control)) {
        showMenu();
        return;
      }
      if (type !== NSEventTypeLeftMouseUp) return;
      const clicks = BigInt(sendInt(event, sel("clickCount")) ?? 1);
      if (clicks >= 2n) {
        sendPtrSelPtrVoid(cls("NSObject"), sel("cancelPreviousPerformRequestsWithTarget:selector:object:"), target, sel("traySingleClick:"), NIL);
        options.onDoubleClick?.();
      } else if (options.onClick) {
        const delay = Number(sendRetF64(cls("NSEvent"), sel("doubleClickInterval")) ?? 0.3);
        sendSelPtrF64(target, sel("performSelector:withObject:afterDelay:"), sel("traySingleClick:"), NIL, delay);
      }
    },
    "traySingleClick:": () => options.onClick?.(),
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
      sendPtrSelPtrVoid(cls("NSObject"), sel("cancelPreviousPerformRequestsWithTarget:selector:object:"), target, sel("traySingleClick:"), NIL);
      sendPtr(statusBar, sel("removeStatusItem:"), item);
      release(item);
      built?.dispose();
      built = undefined;
    },
  };
}
