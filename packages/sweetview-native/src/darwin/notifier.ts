// macOS notifications through UNUserNotificationCenter.
//
// Eagerly registers the shared delegate when Notifier is constructed (when
// running inside a bundled .app) so cold-launch notification clicks arrive as
// soon as the event loop runs, without waiting for the first notify() call.
// Reuses one shared ObjC delegate and one pair of global completion blocks per
// process so repeated Notifier creation never leaks runtime classes or blocks.
// Routes clicks strictly by notification ID to the notifier that sent it, using
// bounded tombstones so disposed or handler-less notifiers never leak clicks
// into unrelated notifiers and the map never grows without bound. Every
// notification also carries a per-process tag in its userInfo, so a click on
// one whose ID aged out of the map is still recognised as this process's and
// dropped, never misrouted as a cold-launch click.

import { FFIType } from "bun:ffi";
import { reportCallbackError } from "../callback-errors";
import { type NotificationClick, type NotifierBackend, type NotifierOptions, notificationId } from "../notifications";
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
const DATA_KEY = "sweetview.data";
// userInfo key carrying the tag of the process that sent the notification, so a click on a
// notification this process sent is never taken for a cold-launch click, even after its ID
// was evicted from the bounded map below.
const PROCESS_KEY = "sweetview.process";
const PROCESS_TAG = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const MAX_TRACKED_IDS = 256;

function readClick(response: Id): NotificationClick & { fromThisProcess: boolean } {
  const request = asId(send(asId(send(response, sel("notification"))), sel("request")));
  const id = jsString(asId(send(request, sel("identifier"))));
  const userInfo = asId(send(asId(send(request, sel("content"))), sel("userInfo")));
  const json = userInfo === NIL ? NIL : asId(sendPtr(userInfo, sel("objectForKey:"), nsString(DATA_KEY)));
  const tag = userInfo === NIL ? NIL : asId(sendPtr(userInfo, sel("objectForKey:"), nsString(PROCESS_KEY)));
  return { id, data: json === NIL ? undefined : JSON.parse(jsString(json)), fromThisProcess: tag !== NIL && jsString(tag) === PROCESS_TAG };
}

const bundled = (): boolean => asId(send(asId(send(cls("NSBundle"), sel("mainBundle"))), sel("bundleIdentifier"))) !== NIL;

type NotifierEntry = {
  readonly token: symbol;
  readonly onClick?: (click: NotificationClick) => void;
};

let sharedDelegate: Id = NIL;
let sharedAuthBlock: Id = NIL;
let sharedRequestBlock: Id = NIL;
const liveNotifiers = new Set<NotifierEntry>();
/**
 * Bounded insertion-ordered map of notification IDs sent in this process:
 * - `NotifierEntry`: owned by that live notifier
 * - `null`: sent by a notifier in this process that was since disposed (tombstone so clicks never fall through to another notifier)
 */
const sentByThisProcess = new Map<string, NotifierEntry | null>();

function recordSent(id: string, entry: NotifierEntry): void {
  if (sentByThisProcess.has(id)) sentByThisProcess.delete(id);
  sentByThisProcess.set(id, entry);
  while (sentByThisProcess.size > MAX_TRACKED_IDS) {
    const oldest = sentByThisProcess.keys().next().value;
    if (oldest === undefined) break;
    sentByThisProcess.delete(oldest);
  }
}

function deliverClick({ fromThisProcess, ...click }: NotificationClick & { fromThisProcess: boolean }): void {
  if (sentByThisProcess.has(click.id)) {
    const owner = sentByThisProcess.get(click.id);
    sentByThisProcess.delete(click.id);
    // Strict isolation: if sent in this process and the owning notifier was disposed
    // or had no onClick, do NOT fall through to an unrelated notifier.
    if (owner && liveNotifiers.has(owner) && owner.onClick) {
      try {
        owner.onClick(click);
      } catch (err) {
        reportCallbackError("notifier.onClick", err, "sweetview: notification onClick threw:"); // never unwind into AppKit
      }
    }
    return;
  }
  // Sent by this process but its ID was evicted from the bounded map: the owner is unknown, so
  // drop it rather than hand it to an unrelated notifier as if it were a cold-launch click.
  if (fromThisProcess) return;
  // True cold-launch click from a previous process: deliver to the first live notifier with a handler.
  for (const entry of liveNotifiers) {
    if (entry.onClick) {
      try {
        entry.onClick(click);
      } catch (err) {
        reportCallbackError("notifier.onClick", err, "sweetview: notification onClick threw:");
      }
      return;
    }
  }
}

function ensureSharedDelegate(): Id {
  if (sharedDelegate !== NIL) return sharedDelegate;
  sharedDelegate = makeTarget("SweetviewNotificationDelegate", {
    // Called on the main thread while the app is frontmost: show it anyway.
    "userNotificationCenter:willPresentNotification:withCompletionHandler:": {
      args: 3,
      impl: (_center, _notification, handler) => invokeBlock(handler, [FFIType.u64], PRESENT_BANNER_LIST_SOUND),
    },
    // Main thread: the user clicked a notification.
    "userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:": {
      args: 3,
      impl: (_center, response, handler) => {
        try {
          deliverClick(readClick(response));
        } catch (err) {
          reportCallbackError("internal", err, "sweetview: notification click handling threw:");
        }
        invokeBlock(handler, []);
      },
    },
  });
  return sharedDelegate;
}

function ensureSharedBlocks(): { auth: Id; req: Id } {
  if (sharedAuthBlock === NIL) {
    // These bodies run later on Bun's event loop (threadsafe), after the
    // completion handler has returned and its arguments may be freed: compare
    // object arguments with NIL, never send them messages.
    sharedAuthBlock = makeBlock(
      (granted, error) => {
        if (!granted) {
          // macOS answers a user's denial (UNErrorDomain 1, "Notifications are
          // not allowed") and an unsigned or temporary-folder bundle both with
          // an error, so its presence does not tell the two apart.
          console.error(
            error === NIL
              ? "sweetview: notification permission denied by the user"
              : "sweetview: notification permission not granted: turned off for this app in System Settings > Notifications, or refused by macOS because the app is not a signed .app bundle (makeMacApp signs one) or runs from a temporary folder",
          );
        }
      },
      [FFIType.bool, FFIType.u64],
      true,
    );
  }
  if (sharedRequestBlock === NIL) {
    sharedRequestBlock = makeBlock(
      (error) => {
        if (error !== NIL) console.error("sweetview: notification not shown: macOS rejected it (permission refused, denied, or not answered yet)");
      },
      [FFIType.u64],
      true,
    );
  }
  return { auth: sharedAuthBlock, req: sharedRequestBlock };
}

export function createNotifier(options: NotifierOptions = {}): NotifierBackend {
  let disposed = false;
  let authorized = false;
  let center: Id = NIL;
  const entry: NotifierEntry = { token: Symbol("notifier"), onClick: options.onClick };
  const delegate = ensureSharedDelegate();
  liveNotifiers.add(entry);

  const ensureCenter = (): boolean => {
    if (center !== NIL) return true;
    if (!bundled()) return false;
    center = asId(send(cls("UNUserNotificationCenter"), sel("currentNotificationCenter")));
    if (center === NIL) return false;
    sendPtr(center, sel("setDelegate:"), delegate);
    return true;
  };

  // Eagerly register delegate so cold-launch notification clicks are delivered immediately.
  ensureCenter();

  const ensureAuthorized = () => {
    if (authorized) return;
    authorized = true;
    const { auth } = ensureSharedBlocks();
    sendUIntPtrVoid(
      center,
      sel("requestAuthorizationWithOptions:completionHandler:"),
      UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge,
      auth,
    );
  };

  return {
    notify(n) {
      if (disposed || !ensureCenter()) return false;
      ensureAuthorized();
      const { req } = ensureSharedBlocks();
      const id = notificationId(n);
      recordSent(id, entry);
      const content = asId(send(allocRaw("UNMutableNotificationContent"), sel("init")));
      sendPtr(content, sel("setTitle:"), nsString(n.title));
      if (n.body) sendPtr(content, sel("setBody:"), nsString(n.body));
      if (!n.silent) sendPtr(content, sel("setSound:"), asId(send(cls("UNNotificationSound"), sel("defaultSound"))));
      const userInfo = asId(send(cls("NSMutableDictionary"), sel("dictionary")));
      sendPtrPtr(userInfo, sel("setObject:forKey:"), nsString(PROCESS_TAG), nsString(PROCESS_KEY));
      if (n.data !== undefined) sendPtrPtr(userInfo, sel("setObject:forKey:"), nsString(JSON.stringify(n.data)), nsString(DATA_KEY));
      sendPtr(content, sel("setUserInfo:"), userInfo);
      const request = asId(sendPtrPtrPtr(cls("UNNotificationRequest"), sel("requestWithIdentifier:content:trigger:"), nsString(id), content, NIL));
      sendPtrPtr(center, sel("addNotificationRequest:withCompletionHandler:"), request, req);
      release(content); // the request retains it
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      liveNotifiers.delete(entry);
      for (const [id, owner] of sentByThisProcess) {
        if (owner === entry) sentByThisProcess.set(id, null);
      }
      if (liveNotifiers.size === 0 && center !== NIL && asId(send(center, sel("delegate"))) === delegate) {
        sendPtr(center, sel("setDelegate:"), NIL);
      }
    },
  };
}
