// What the window lists, shared by the page (labels) and the UI thread (what
// each row asks macOS), and the usage descriptions the .app bundle carries.

import type { Permission, PermissionStatus, ProtectedFolder, SettingsPane } from "@n1h/sweetview/native";

export type Row = {
  /** Names the row between the page and the UI thread. */
  id: string;
  label: string;
  /** What it lets an app do. */
  caption: string;
  pane: SettingsPane;
  /** macOS has no prompt for it: the user switches it on in Settings. */
  settingsOnly?: true;
  ask: { permission: Permission } | { automate: string } | { folder: ProtectedFolder };
};

export type Group = { title: string; rows: Row[] };

const permission = (id: Permission, label: string, caption: string): Row => ({ id, label, caption, pane: id, ask: { permission: id } });
const folder = (id: ProtectedFolder, label: string): Row => ({ id: `folder:${id}`, label, caption: "macOS asks when the folder is first read", pane: "files-and-folders", ask: { folder: id } });

export const FINDER = "com.apple.finder";

export const GROUPS: Group[] = [
  {
    title: "Input and the screen",
    rows: [
      permission("ax-trust", "Control of Other Apps", "Read and drive other apps' windows; the Device Control and Data Access row"),
      permission("device-control", "Sending Input", "Post keyboard and mouse events; the Device Control and Data Access row"),
      permission("input-monitoring", "Input Monitoring", "See keyboard and mouse input meant for other apps"),
      permission("screen-recording", "Screen Recording", "Capture the screen and other apps' windows"),
    ],
  },
  {
    title: "Camera and sound",
    rows: [
      permission("camera", "Camera", "Capture video"),
      permission("microphone", "Microphone", "Capture audio"),
      permission("speech-recognition", "Speech Recognition", "Send audio to Apple to be transcribed"),
    ],
  },
  {
    title: "Personal data",
    rows: [
      permission("contacts", "Contacts", "Read and change contacts"),
      permission("calendars", "Calendars", "Read and change events"),
      permission("calendars-write-only", "Calendars, Add Only", "Add events without reading any"),
      permission("reminders", "Reminders", "Read and change reminders"),
      permission("photos", "Photos", "Read and change the photo library"),
      permission("photos-add-only", "Photos, Add Only", "Add photos without reading any"),
      permission("music-library", "Media & Apple Music", "Read the music library and Apple Music activity"),
    ],
  },
  {
    title: "Location and devices",
    rows: [
      permission("location", "Location, While in Use", "Where this Mac is, while the app is used"),
      permission("location-always", "Location, Always", "Where this Mac is, at any time"),
      permission("bluetooth", "Bluetooth", "Find and connect to Bluetooth devices"),
      permission("focus-status", "Focus", "Whether a Focus is silencing notifications"),
      permission("external-storage", "Removable Volumes", "Read cameras' and readers' storage"),
    ],
  },
  {
    title: "Files and other apps",
    rows: [
      { ...permission("full-disk-access", "Full Disk Access", "Read every file; macOS has no prompt for it, only the switch in Settings"), settingsOnly: true },
      folder("desktop", "Desktop Folder"),
      folder("documents", "Documents Folder"),
      folder("downloads", "Downloads Folder"),
      { id: `automation:${FINDER}`, label: "Automation: Finder", caption: "Send Apple Events to Finder; one answer per app controlled", pane: "automation", ask: { automate: FINDER } },
    ],
  },
];

export const ROWS: Row[] = GROUPS.flatMap((group) => group.rows);

/** `unknown`: a folder nobody asked for yet in this run; macOS has no call that reads it without asking. */
export type RowStatus = PermissionStatus | "unknown";

export type Snapshot = {
  /** The .app's bundle id, or null for a bare binary, whose grants belong to the app that launched it. */
  bundleId: string | null;
  platform: string;
  /** By row id. */
  statuses: Record<string, RowStatus>;
};

export type AskResult = { status: RowStatus } | { error: string };

/** method name -> [params, result]; all answered on the UI thread. */
export type Methods = {
  "permissions.snapshot": [void, Snapshot];
  "permissions.ask": [{ id: string }, AskResult];
  "permissions.settings": [{ id: string }, boolean];
};

export type Events = Record<never, never>;

const WHY = "The Permissions demo asks so you can see the prompt and the answer.";

/** One `Info.plist` usage description per permission the window can ask for. Both generations of the calendar keys, so the bundle works before and after macOS 14. */
export const USAGE_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  [
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSSpeechRecognitionUsageDescription",
    "NSContactsUsageDescription",
    "NSCalendarsFullAccessUsageDescription",
    "NSCalendarsWriteOnlyAccessUsageDescription",
    "NSCalendarsUsageDescription",
    "NSRemindersFullAccessUsageDescription",
    "NSRemindersUsageDescription",
    "NSPhotoLibraryUsageDescription",
    "NSPhotoLibraryAddUsageDescription",
    "NSAppleMusicUsageDescription",
    "NSLocationWhenInUseUsageDescription",
    "NSLocationAlwaysAndWhenInUseUsageDescription",
    "NSLocationUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSFocusStatusUsageDescription",
    "NSAppleEventsUsageDescription",
    "NSDesktopFolderUsageDescription",
    "NSDocumentsFolderUsageDescription",
    "NSDownloadsFolderUsageDescription",
  ].map((key) => [key, WHY]),
);
