// Show/hide and close interception for the webview's NSWindow. The close hook
// retargets the red close button to our own target instead of replacing the
// window delegate, so webview's delegate (windowWillClose: -> quit) is
// untouched for the real quit path.

import type { NativeWindow, WindowHandle } from "../window";
import { NIL, type Id, makeTarget, sel, send, sendBool, sendPtr, sendRetBool, sendUIntRetPtr, sharedApp } from "./objc";

const NSWindowCloseButton = 0n;

const closeHandlers = new Map<Id, () => void>();
let target: Id | undefined;
const closeTarget = () =>
  (target ??= makeTarget("NativeShellCloseTarget", {
    "closeRequested:": (sender) => {
      // sender is the button; its window is the one being closed.
      const win = send(sender, sel("window"));
      closeHandlers.get(win === null ? NIL : BigInt(win))?.();
    },
  }));

export const asNSWindow = (handle: WindowHandle): Id => {
  if (handle === null || handle === 0 || handle === 0n) throw new Error("sweetnative: window handle is nil");
  return BigInt(handle);
};

export function nativeWindow(handle: WindowHandle): NativeWindow {
  const win = asNSWindow(handle);
  const closeButton = () => {
    const b = sendUIntRetPtr(win, sel("standardWindowButton:"), NSWindowCloseButton);
    return b === null ? NIL : BigInt(b);
  };
  const self: NativeWindow = {
    isVisible: () => Boolean(sendRetBool(win, sel("isVisible"))),
    show() {
      sendPtr(win, sel("makeKeyAndOrderFront:"), NIL);
      sendBool(sharedApp(), sel("activateIgnoringOtherApps:"), true);
    },
    hide() {
      sendPtr(win, sel("orderOut:"), NIL);
    },
    toggle() {
      if (self.isVisible()) self.hide();
      else self.show();
    },
    setIcon() {
      // A Cocoa window has no icon of its own; setAppIcon covers the Dock.
    },
    onCloseRequest(handler) {
      const button = closeButton();
      if (button === NIL) throw new Error("sweetnative: window has no close button");
      closeHandlers.set(win, handler);
      sendPtr(button, sel("setTarget:"), closeTarget());
      sendPtr(button, sel("setAction:"), sel("closeRequested:"));
      return () => {
        if (closeHandlers.get(win) !== handler) return;
        closeHandlers.delete(win);
        sendPtr(button, sel("setTarget:"), NIL);
        sendPtr(button, sel("setAction:"), sel("performClose:"));
      };
    },
  };
  return self;
}
