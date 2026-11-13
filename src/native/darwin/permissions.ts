// macOS privacy permissions (System Settings > Privacy & Security), asked of
// the system through the same calls an Objective-C app makes: what a
// permission's status is, the system's own prompt for it, and its Settings
// pane. The map of permission to call follows codebytere/node-mac-permissions
// (MIT), ported to bun:ffi.
//
// Every call here is synchronous and none waits for the user. The frameworks
// answer a request on a background queue; Bun queues such a callback for its
// event loop, which a webview's `run()` blocks, so the completion blocks here
// do nothing and the caller reads the status again instead (`waitForPermission`
// polls it).
//
// A grant belongs to the app that asks, by code identity: a bare `bun` script
// gets its terminal's grants, a signed .app its own.

import { FFIType, dlopen } from "bun:ffi";
import { closeSync, openSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Permission, PermissionStatus, ProtectedFolder, SettingsPane } from "../permissions";
import {
  NIL,
  type Id,
  alloc,
  asId,
  cls,
  findClass,
  jsString,
  loadFramework,
  makeBlock,
  nsString,
  objectConstant,
  sel,
  send,
  sendBoolRetPtr,
  sendInt,
  sendPtr,
  sendPtrPtr,
  sendPtrPtrVoid,
  sendPtrRetBool,
  sendPtrRetInt,
  sendPtrVoid,
  sendUInt,
  sendUIntPtrVoid,
  sendVoid,
} from "./objc";

/** Evaluates `make` on first use and keeps the result: a framework, a manager object, a block. */
function lazy<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

const framework = (name: string) => `/System/Library/Frameworks/${name}.framework/${name}`;

const hiServices = lazy(
  () =>
    dlopen(framework("ApplicationServices"), {
      AXIsProcessTrusted: { args: [], returns: FFIType.bool },
      AXIsProcessTrustedWithOptions: { args: [FFIType.u64], returns: FFIType.bool },
    }).symbols,
);
const coreGraphics = lazy(
  () =>
    dlopen(framework("CoreGraphics"), {
      CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
      CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
      CGRequestPostEventAccess: { args: [], returns: FFIType.bool },
      CGRequestListenEventAccess: { args: [], returns: FFIType.bool },
    }).symbols,
);
const ioKit = lazy(() => dlopen(framework("IOKit"), { IOHIDCheckAccess: { args: [FFIType.u32], returns: FFIType.u32 } }).symbols);
const coreServices = lazy(
  () =>
    dlopen(framework("CoreServices"), {
      AECreateDesc: { args: [FFIType.u32, FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.i16 },
      AEDisposeDesc: { args: [FFIType.ptr], returns: FFIType.i16 },
      AEDeterminePermissionToAutomateTarget: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.bool], returns: FFIType.i32 },
    }).symbols,
);
const foundation = lazy(
  () => dlopen(framework("Foundation"), { NSSearchPathForDirectoriesInDomains: { args: [FFIType.u64, FFIType.u64, FFIType.bool], returns: FFIType.u64 } }).symbols,
);

// The frameworks' authorization enums, by number. Most share this order...
const RESTRICTED_FIRST: PermissionStatus[] = ["not-determined", "restricted", "denied", "granted"];
// ...and Speech and StoreKit have denied before restricted.
const DENIED_FIRST: PermissionStatus[] = ["not-determined", "denied", "restricted", "granted"];
const named = (order: PermissionStatus[], value: unknown): PermissionStatus => order[Number(value)] ?? "not-determined";

// Completion handlers, one per parameter list. Each is called on a background queue and does nothing: see the top of the file.
const answered = {
  /** `^(BOOL granted)` */
  flag: lazy(() => makeBlock(() => {}, [FFIType.bool], true)),
  /** `^(BOOL granted, NSError *error)` */
  flagAndError: lazy(() => makeBlock(() => {}, [FFIType.bool, FFIType.u64], true)),
  /** `^(NSInteger status)` */
  status: lazy(() => makeBlock(() => {}, [FFIType.i64], true)),
};

type Entry = {
  /** What macOS says now. Shows nothing. */
  status(): PermissionStatus;
  /** The system's own way to ask, for a permission that has one. Does not wait for the answer. */
  request?(): void;
  /** `Info.plist` keys, one of which a bundled app must have before `request`: macOS refuses the request, or ends the process, without it. */
  usage?(): string[];
  /** The anchor of this permission's pane in System Settings > Privacy & Security. */
  pane: string;
};

// The anchor of the Device Control and Data Access row still carries the name
// that row had before macOS 27. That name is not written in this codebase, so
// the anchor is put together from two pieces.
const DEVICE_CONTROL_PANE = "Privacy_" + ["Access", "ibility"].join("");

// --- Input and the screen: plain C calls --------------------------------------

const IOHID_POST_EVENT = 0;
const IOHID_LISTEN_EVENT = 1;
/** IOHIDAccessType: 0 granted, 1 denied, 2 unknown (never asked). */
const hidStatus = (requestType: number): PermissionStatus => (["granted", "denied", "not-determined"] as const)[ioKit().IOHIDCheckAccess(requestType)] ?? "not-determined";

function askForAxTrust(): void {
  const prompt = objectConstant("ApplicationServices", "kAXTrustedCheckOptionPrompt");
  const yes = asId(sendBoolRetPtr(cls("NSNumber"), sel("numberWithBool:"), true));
  hiServices().AXIsProcessTrustedWithOptions(asId(sendPtrPtr(cls("NSDictionary"), sel("dictionaryWithObject:forKey:"), yes, prompt)));
}

// --- Camera, microphone and removable volumes: AVFoundation ----------------------

function capture(mediaType: "AVMediaTypeVideo" | "AVMediaTypeAudio", usageKey: string, pane: string): Entry {
  const device = lazy(() => (loadFramework("AVFoundation"), { class: cls("AVCaptureDevice"), type: objectConstant("AVFoundation", mediaType) }));
  return {
    status: () => named(RESTRICTED_FIRST, sendPtrRetInt(device().class, sel("authorizationStatusForMediaType:"), device().type)),
    request: () => void sendPtrPtrVoid(device().class, sel("requestAccessForMediaType:completionHandler:"), device().type, answered.flag()),
    usage: () => [usageKey],
    pane,
  };
}

/** AVExternalStorageDevice is macOS 14 and later; NIL before that. */
const externalStorage = lazy(() => (loadFramework("AVFoundation"), findClass("AVExternalStorageDevice")));

// --- Calendars and reminders: EventKit -------------------------------------------

const EK_EVENT = 0n;
const EK_REMINDER = 1n;
const EK_WRITE_ONLY = 4n;
const eventStoreClass = lazy(() => (loadFramework("EventKit"), cls("EKEventStore")));
/** One store for the process: a request needs it alive until the user answers. */
const eventStore = lazy(() => (loadFramework("EventKit"), alloc("EKEventStore")));
/** macOS 14 split calendar access into full and write-only, with a request call and a usage key for each. */
const eventKitHasAccessLevels = lazy(() => Boolean(sendPtrRetBool(eventStoreClass(), sel("instancesRespondToSelector:"), sel("requestFullAccessToEventsWithCompletion:"))));
const eventKitStatus = (entity: bigint) => asId(sendUInt(eventStoreClass(), sel("authorizationStatusForEntityType:"), entity) as bigint);

function eventKit(entity: bigint, modernRequest: string, modernUsageKey: string, legacyUsageKey: string, status: (value: bigint) => PermissionStatus, pane: string): Entry {
  return {
    status: () => status(eventKitStatus(entity)),
    request: () =>
      void (eventKitHasAccessLevels()
        ? sendPtrVoid(eventStore(), sel(modernRequest), answered.flagAndError())
        : sendUIntPtrVoid(eventStore(), sel("requestAccessToEntityType:completion:"), entity, answered.flagAndError())),
    usage: () => [eventKitHasAccessLevels() ? modernUsageKey : legacyUsageKey],
    pane,
  };
}

// --- Photos ------------------------------------------------------------------------

const photoLibrary = lazy(() => (loadFramework("Photos"), cls("PHPhotoLibrary")));
function photos(accessLevel: bigint, usageKey: string): Entry {
  return {
    // PHAuthorizationStatus adds 4: limited, the user picked some photos.
    status: () => named([...RESTRICTED_FIRST, "limited"], sendUInt(photoLibrary(), sel("authorizationStatusForAccessLevel:"), accessLevel)),
    request: () => void sendUIntPtrVoid(photoLibrary(), sel("requestAuthorizationForAccessLevel:handler:"), accessLevel, answered.status()),
    usage: () => [usageKey],
    pane: "Privacy_Photos",
  };
}

// --- Speech recognition and the music library: one class method each ---------------

function classAuthorization(frameworkName: string, className: string, usageKey: string, pane: string): Entry {
  const klass = lazy(() => (loadFramework(frameworkName), cls(className)));
  return {
    status: () => named(DENIED_FIRST, sendInt(klass(), sel("authorizationStatus"))),
    request: () => void sendPtrVoid(klass(), sel("requestAuthorization:"), answered.status()),
    usage: () => [usageKey],
    pane,
  };
}

// --- Location ------------------------------------------------------------------------

const CL_ALWAYS = 3n;
const CL_WHEN_IN_USE = 4n;
const newLocationManager = () => (loadFramework("CoreLocation"), alloc("CLLocationManager"));
/** Reads the status, on whichever thread reads first. */
const locationReader = lazy(newLocationManager);
/**
 * Asks. Kept for the process, because its prompt goes away when the manager is
 * released, and apart from the reader, because Core Location answers on the run
 * loop of the thread that made the manager: this one is made by the first
 * request, on the UI thread, where a reader made by a worker would have none.
 */
const locationAsker = lazy(newLocationManager);
function location(request: string, usageKeys: string[], status: (value: bigint) => PermissionStatus): Entry {
  return {
    status: () => status(asId(sendInt(locationReader(), sel("authorizationStatus")) as bigint)),
    request: () => void sendVoid(locationAsker(), sel(request)),
    usage: () => usageKeys,
    pane: "Privacy_LocationServices",
  };
}

// --- Bluetooth and Focus -------------------------------------------------------------

const bluetoothManagerClass = lazy(() => (loadFramework("CoreBluetooth"), cls("CBManager")));
/** Core Bluetooth has no request call: the prompt comes from making a central manager, which is then kept. */
const bluetoothCentral = lazy(() => (loadFramework("CoreBluetooth"), alloc("CBCentralManager")));

/** INFocusStatusCenter is macOS 12 and later; NIL before that. */
const focusCenter = lazy((): Id => {
  loadFramework("Intents");
  const klass = findClass("INFocusStatusCenter");
  return klass === NIL ? NIL : asId(send(klass, sel("defaultCenter")));
});

// --- Full Disk Access: no call exists, so try to read what only it unlocks ----------

function fullDiskAccessStatus(): PermissionStatus {
  const home = userInfo().homedir; // the real home, also inside an app sandbox
  const protectedFiles = [
    join(home, "Library/Application Support/com.apple.TCC/TCC.db"),
    join(home, "Library/Safari/Bookmarks.plist"),
    join(home, "Library/Safari/CloudTabs.db"),
    "/Library/Preferences/com.apple.TimeMachine.plist",
  ];
  for (const file of protectedFiles) {
    try {
      closeSync(openSync(file, "r"));
      return "granted";
    } catch {
      // Not there, or not allowed: the next file may still open.
    }
  }
  return "missing";
}

const entries: Record<Permission, Entry> = {
  "ax-trust": {
    status: () => (hiServices().AXIsProcessTrusted() ? "granted" : "missing"),
    request: askForAxTrust,
    pane: DEVICE_CONTROL_PANE,
  },
  "device-control": {
    status: () => hidStatus(IOHID_POST_EVENT),
    request: () => void coreGraphics().CGRequestPostEventAccess(),
    pane: DEVICE_CONTROL_PANE,
  },
  "input-monitoring": {
    status: () => hidStatus(IOHID_LISTEN_EVENT),
    request: () => void coreGraphics().CGRequestListenEventAccess(),
    pane: "Privacy_ListenEvent",
  },
  "screen-recording": {
    status: () => (coreGraphics().CGPreflightScreenCaptureAccess() ? "granted" : "missing"),
    request: () => void coreGraphics().CGRequestScreenCaptureAccess(),
    pane: "Privacy_ScreenCapture",
  },
  camera: capture("AVMediaTypeVideo", "NSCameraUsageDescription", "Privacy_Camera"),
  microphone: capture("AVMediaTypeAudio", "NSMicrophoneUsageDescription", "Privacy_Microphone"),
  contacts: (() => {
    const storeClass = lazy(() => (loadFramework("Contacts"), cls("CNContactStore")));
    const store = lazy(() => (loadFramework("Contacts"), alloc("CNContactStore")));
    const CN_CONTACTS = 0n;
    return {
      status: () => named(RESTRICTED_FIRST, sendUInt(storeClass(), sel("authorizationStatusForEntityType:"), CN_CONTACTS)),
      request: () => void sendUIntPtrVoid(store(), sel("requestAccessForEntityType:completionHandler:"), CN_CONTACTS, answered.flagAndError()),
      usage: () => ["NSContactsUsageDescription"],
      pane: "Privacy_Contacts",
    };
  })(),
  calendars: eventKit(
    EK_EVENT,
    "requestFullAccessToEventsWithCompletion:",
    "NSCalendarsFullAccessUsageDescription",
    "NSCalendarsUsageDescription",
    (value) => (value === EK_WRITE_ONLY ? "limited" : named(RESTRICTED_FIRST, value)),
    "Privacy_Calendars",
  ),
  "calendars-write-only": eventKit(
    EK_EVENT,
    "requestWriteOnlyAccessToEventsWithCompletion:",
    "NSCalendarsWriteOnlyAccessUsageDescription",
    "NSCalendarsUsageDescription",
    (value) => (value === EK_WRITE_ONLY ? "granted" : named(RESTRICTED_FIRST, value)),
    "Privacy_Calendars",
  ),
  reminders: eventKit(
    EK_REMINDER,
    "requestFullAccessToRemindersWithCompletion:",
    "NSRemindersFullAccessUsageDescription",
    "NSRemindersUsageDescription",
    (value) => named(RESTRICTED_FIRST, value),
    "Privacy_Reminders",
  ),
  photos: photos(2n, "NSPhotoLibraryUsageDescription"),
  "photos-add-only": photos(1n, "NSPhotoLibraryAddUsageDescription"),
  "speech-recognition": classAuthorization("Speech", "SFSpeechRecognizer", "NSSpeechRecognitionUsageDescription", "Privacy_SpeechRecognition"),
  "music-library": classAuthorization("StoreKit", "SKCloudServiceController", "NSAppleMusicUsageDescription", "Privacy_Media"),
  location: location("requestWhenInUseAuthorization", ["NSLocationWhenInUseUsageDescription", "NSLocationUsageDescription"], (value) =>
    value === CL_WHEN_IN_USE ? "granted" : named(RESTRICTED_FIRST, value),
  ),
  "location-always": location("requestAlwaysAuthorization", ["NSLocationAlwaysAndWhenInUseUsageDescription", "NSLocationUsageDescription"], (value) =>
    value === CL_WHEN_IN_USE ? "limited" : named(RESTRICTED_FIRST, value),
  ),
  bluetooth: {
    status: () => named(RESTRICTED_FIRST, sendInt(bluetoothManagerClass(), sel("authorization"))),
    request: () => void bluetoothCentral(),
    usage: () => ["NSBluetoothAlwaysUsageDescription"],
    pane: "Privacy_Bluetooth",
  },
  "focus-status": {
    status: () => (focusCenter() === NIL ? "not-applicable" : named(RESTRICTED_FIRST, sendInt(focusCenter(), sel("authorizationStatus")))),
    request: () => void sendPtrVoid(focusCenter(), sel("requestAuthorizationWithCompletionHandler:"), answered.status()),
    usage: () => ["NSFocusStatusUsageDescription"],
    pane: "Privacy_Focus",
  },
  "external-storage": {
    status: () => (externalStorage() === NIL ? "not-applicable" : named(RESTRICTED_FIRST, sendInt(externalStorage(), sel("authorizationStatus")))),
    request: () => void sendPtrVoid(externalStorage(), sel("requestAccessWithCompletionHandler:"), answered.flag()),
    pane: "Privacy_RemovableVolume",
  },
  "full-disk-access": { status: fullDiskAccessStatus, pane: "Privacy_AllFiles" },
};

const panes: Record<SettingsPane, string> = {
  ...(Object.fromEntries(Object.entries(entries).map(([permission, entry]) => [permission, entry.pane])) as Record<Permission, string>),
  automation: "Privacy_Automation",
  "files-and-folders": "Privacy_FilesAndFolders",
};

const mainBundle = () => asId(send(cls("NSBundle"), sel("mainBundle")));
const isBundled = () => asId(send(mainBundle(), sel("bundleIdentifier"))) !== NIL;
const infoPlistHas = (key: string) => asId(sendPtr(mainBundle(), sel("objectForInfoDictionaryKey:"), nsString(key))) !== NIL;

/**
 * The error for asking without a usage description, or undefined when the
 * request may go ahead. A bare binary has no `Info.plist` of its own: its
 * requests are made in the name of whatever launched it, so nothing is checked.
 */
export function usageDescriptionError(call: string, keys: string[], bundled: boolean, has: (key: string) => boolean): string | undefined {
  if (!bundled || keys.length === 0 || keys.some(has)) return undefined;
  return `sweetnative: ${call}: the app's Info.plist has no ${keys.join(" or ")}, and macOS refuses the request, or ends the process, without it (makeMacApp's plist option adds one)`;
}

function requireUsageDescription(call: string, keys: string[]): void {
  const error = usageDescriptionError(call, keys, isBundled(), infoPlistHas);
  if (error !== undefined) throw new Error(error);
}

export function permissionStatus(permission: Permission): PermissionStatus {
  return entries[permission].status();
}

export function requestPermission(permission: Permission): PermissionStatus {
  const entry = entries[permission];
  const before = entry.status();
  if (before === "granted" || before === "not-applicable" || entry.request === undefined) return before;
  requireUsageDescription(`requestPermission("${permission}")`, usageDescriptionKeys(permission));
  entry.request();
  return entry.status();
}

export function usageDescriptionKeys(permission: Permission): string[] {
  return entries[permission].usage?.() ?? [];
}

/** The System Settings URL of the pane. The old bundle id is the one macOS still maps to Privacy & Security. */
export const settingsUrl = (pane: SettingsPane): string => `x-apple.systempreferences:com.apple.preference.security?${panes[pane]}`;

export function openPermissionSettings(pane: SettingsPane): boolean {
  return Bun.spawnSync(["/usr/bin/open", settingsUrl(pane)]).exitCode === 0;
}

// --- Automation: one answer per app this process would send Apple Events to ---------

const fourCharCode = (code: string) => ((code.charCodeAt(0) << 24) | (code.charCodeAt(1) << 16) | (code.charCodeAt(2) << 8) | code.charCodeAt(3)) >>> 0;
const TYPE_APPLICATION_BUNDLE_ID = fourCharCode("bund");
const TYPE_WILDCARD = fourCharCode("****"); // any event class, any event id; macOS files the answer per target app, not per event
const AE_GRANTED = 0;
const AE_USER_CANCELED = -128;
const AE_TARGET_NOT_RUNNING = -600; // procNotFound
const AE_NOT_PERMITTED = -1743;
const AE_WOULD_REQUIRE_CONSENT = -1744;

function automation(call: string, targetBundleId: string, ask: boolean): PermissionStatus {
  if (ask) requireUsageDescription(`${call}("${targetBundleId}")`, ["NSAppleEventsUsageDescription"]);
  const ae = coreServices();
  const bundleId = new TextEncoder().encode(targetBundleId);
  const target = new Uint8Array(16); // an AEDesc: { DescType descriptorType; AEDataStorage dataHandle; }
  const created = ae.AECreateDesc(TYPE_APPLICATION_BUNDLE_ID, bundleId, bundleId.length, target);
  if (created !== 0) throw new Error(`sweetnative: ${call}("${targetBundleId}"): AECreateDesc failed with ${created}`);
  try {
    const answer = ae.AEDeterminePermissionToAutomateTarget(target, TYPE_WILDCARD, TYPE_WILDCARD, ask);
    switch (answer) {
      case AE_GRANTED:
        return "granted";
      case AE_NOT_PERMITTED:
        return "denied";
      case AE_WOULD_REQUIRE_CONSENT:
      case AE_USER_CANCELED:
        return "not-determined";
      case AE_TARGET_NOT_RUNNING:
        return "missing"; // macOS answers only for a running target
      default:
        throw new Error(`sweetnative: ${call}("${targetBundleId}"): AEDeterminePermissionToAutomateTarget answered ${answer}`);
    }
  } finally {
    ae.AEDisposeDesc(target);
  }
}

export const automationStatus = (targetBundleId: string): PermissionStatus => automation("automationStatus", targetBundleId, false);
export const requestAutomation = (targetBundleId: string): PermissionStatus => automation("requestAutomation", targetBundleId, true);

// --- Desktop, Documents, Downloads: the prompt comes from the first access ----------

const NS_USER_DOMAIN = 1n;
/** NSSearchPathDirectory */
const searchPathDirectory: Record<ProtectedFolder, bigint> = { desktop: 12n, documents: 9n, downloads: 15n };

export function requestFolderAccess(folder: ProtectedFolder): PermissionStatus {
  const paths = asId(foundation().NSSearchPathForDirectoriesInDomains(searchPathDirectory[folder], NS_USER_DOMAIN, true));
  const first = paths === NIL ? NIL : asId(send(paths, sel("firstObject")));
  if (first === NIL) throw new Error(`sweetnative: requestFolderAccess("${folder}"): macOS named no such folder for this user`);
  try {
    readdirSync(jsString(first));
    return "granted";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return "denied";
    throw error;
  }
}
