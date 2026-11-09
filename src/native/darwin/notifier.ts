// macOS notifications through UNUserNotificationCenter. It needs a bundle
// identifier, so this works from the .app and silently does nothing from the
// bare binary (`bun run dev`): currentNotificationCenter would raise there.
//
// The first notify() asks for permission (system prompt, once per bundle id).
// A delegate makes banners show while the app is frontmost and routes clicks.

import { FFIType } from "bun:ffi";
import type { Notifier, NotifierOptions } from "../notifications";
import {
  NIL,
  type Id,
  allocRaw,
  asId,
  cls,
  invokeBlock,
  makeBlock,
  makeTarget,
  nsString,
  release,
  sel,
  send,
  sendPtr,
  sendPtrPtr,
  sendPtrPtrPtr,
  sendUIntPtrVoid,
} from "./objc";

const UNAuthorizationOptionBadge = 1n;
const UNAuthorizationOptionSound = 2n;
const UNAuthorizationOptionAlert = 4n;
// UNNotificationPresentationOptions (macOS 11+): list | banner | sound
const PRESENT_BANNER_LIST_SOUND = 8n | 16n | 2n;

let nextId = 1;

const bundled = (): boolean => asId(send(asId(send(cls("NSBundle"), sel("mainBundle"))), sel("bundleIdentifier"))) !== NIL;

export function createNotifier(options: NotifierOptions = {}): Notifier {
  let disposed = false;
  let authorized = false; // asked, not necessarily granted; the answer arrives off-thread and is not awaited
  let center: Id = NIL;

  const delegate = makeTarget("NativeShellNotificationDelegate", {
    // Called on the main thread while the app is frontmost: show it anyway.
    "userNotificationCenter:willPresentNotification:withCompletionHandler:": {
      args: 3,
      impl: (_center, _notification, handler) => invokeBlock(handler, [FFIType.u64], PRESENT_BANNER_LIST_SOUND),
    },
    // Main thread: the user clicked (or dismissed) a notification.
    "userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:": {
      args: 3,
      impl: (_center, _response, handler) => {
        if (!disposed) options.onClick?.();
        invokeBlock(handler, []);
      },
    },
  });

  const ensureCenter = (): boolean => {
    if (center !== NIL) return true;
    if (!bundled()) return false;
    center = asId(send(cls("UNUserNotificationCenter"), sel("currentNotificationCenter")));
    if (center === NIL) return false;
    sendPtr(center, sel("setDelegate:"), delegate);
    return true;
  };

  const ensureAuthorized = () => {
    if (authorized) return;
    authorized = true;
    const done = makeBlock(() => {}, [FFIType.bool, FFIType.u64], true); // (BOOL granted, NSError*) on a background queue
    sendUIntPtrVoid(center, sel("requestAuthorizationWithOptions:completionHandler:"), UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge, done);
  };

  return {
    notify(n) {
      if (disposed || !ensureCenter()) return false;
      ensureAuthorized();
      const content = asId(send(allocRaw("UNMutableNotificationContent"), sel("init")));
      sendPtr(content, sel("setTitle:"), nsString(n.title));
      if (n.body) sendPtr(content, sel("setBody:"), nsString(n.body));
      if (!n.silent) sendPtr(content, sel("setSound:"), asId(send(cls("UNNotificationSound"), sel("defaultSound"))));
      const request = asId(sendPtrPtrPtr(cls("UNNotificationRequest"), sel("requestWithIdentifier:content:trigger:"), nsString(`sweetnative-${nextId++}`), content, NIL));
      sendPtrPtr(center, sel("addNotificationRequest:withCompletionHandler:"), request, NIL);
      release(content); // the request retains it
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (center !== NIL && asId(send(center, sel("delegate"))) === delegate) sendPtr(center, sel("setDelegate:"), NIL); // a newer notifier's delegate stays
    },
  };
}
