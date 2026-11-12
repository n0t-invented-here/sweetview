// macOS notifications through UNUserNotificationCenter. It needs a bundle
// identifier, so this works from the .app and silently does nothing from the
// bare binary (`bun run dev`): currentNotificationCenter would raise there.
// The bundle must also be signed (makeMacApp signs it ad-hoc) and not live in
// a temporary folder, or macOS refuses the permission request outright with
// UNErrorDomain code 1 and never shows the prompt.
//
// The first notify() asks for permission (system prompt, once per bundle id).
// A delegate makes banners show while the app is frontmost and routes clicks.
//
// The completion handlers log a refused permission or a rejected request to
// the console. Bun runs a threadsafe callback's body later, on its own event
// loop, so they report in an app on `runEventLoop`; behind a webview's `run()`
// the loop is blocked and they never run, which is why `notify` does not wait
// for them. By the time a body runs the NSError the framework passed has been
// released, so the bodies read only the scalar arguments and never touch it.

import { FFIType } from "bun:ffi";
import { type NotificationClick, type Notifier, type NotifierOptions, notificationId } from "../notifications";
import {
  NIL,
  type Id,
  allocRaw,
  asId,
  cls,
  invokeBlock,
  jsString,
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

// userInfo key under which `data` travels, as JSON text.
const DATA_KEY = "sweetnative.data";

/** The clicked notification's request identifier and the JSON under DATA_KEY in its userInfo. */
function readClick(response: Id): NotificationClick {
  const request = asId(send(asId(send(response, sel("notification"))), sel("request")));
  const id = jsString(asId(send(request, sel("identifier"))));
  const userInfo = asId(send(asId(send(request, sel("content"))), sel("userInfo")));
  const json = userInfo === NIL ? NIL : asId(sendPtr(userInfo, sel("objectForKey:"), nsString(DATA_KEY)));
  return { id, data: json === NIL ? undefined : JSON.parse(jsString(json)) };
}

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
    // Main thread: the user clicked a notification. The response is alive for this call, so reading it here is safe.
    "userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:": {
      args: 3,
      impl: (_center, response, handler) => {
        if (!disposed && options.onClick) {
          try {
            options.onClick(readClick(response));
          } catch (err) {
            console.error("sweetnative: notification onClick threw:", err); // never unwind into AppKit
          }
        }
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

  // (BOOL granted, NSError*) on a background queue
  const authorizationDone = makeBlock(
    (granted, error) => {
      if (!granted) console.error(`sweetnative: notification permission ${error === NIL ? "denied by the user" : "refused by macOS: the app is not a signed .app bundle (makeMacApp signs one), or it runs from a temporary folder"}`);
    },
    [FFIType.bool, FFIType.u64],
    true,
  );
  // (NSError*) on a background queue
  const requestDone = makeBlock(
    (error) => {
      if (error !== NIL) console.error("sweetnative: notification not shown: macOS rejected it (permission refused, denied, or not answered yet)");
    },
    [FFIType.u64],
    true,
  );

  const ensureAuthorized = () => {
    if (authorized) return;
    authorized = true;
    sendUIntPtrVoid(center, sel("requestAuthorizationWithOptions:completionHandler:"), UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge, authorizationDone);
  };

  return {
    notify(n) {
      if (disposed || !ensureCenter()) return false;
      ensureAuthorized();
      const content = asId(send(allocRaw("UNMutableNotificationContent"), sel("init")));
      sendPtr(content, sel("setTitle:"), nsString(n.title));
      if (n.body) sendPtr(content, sel("setBody:"), nsString(n.body));
      if (!n.silent) sendPtr(content, sel("setSound:"), asId(send(cls("UNNotificationSound"), sel("defaultSound"))));
      if (n.data !== undefined) {
        const userInfo = asId(sendPtrPtr(cls("NSDictionary"), sel("dictionaryWithObject:forKey:"), nsString(JSON.stringify(n.data)), nsString(DATA_KEY)));
        sendPtr(content, sel("setUserInfo:"), userInfo);
      }
      const request = asId(sendPtrPtrPtr(cls("UNNotificationRequest"), sel("requestWithIdentifier:content:trigger:"), nsString(notificationId(n)), content, NIL));
      sendPtrPtr(center, sel("addNotificationRequest:withCompletionHandler:"), request, requestDone);
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
