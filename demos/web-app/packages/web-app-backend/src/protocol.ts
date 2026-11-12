// The demo's contract. The frontend imports only this file (as types).

export type Info = {
  bun: string;
  platform: string;
  arch: string;
  pid: number;
  compiled: boolean;
  cwd: string;
  /** "webview" inside the app, "web" in a browser */
  host: "webview" | "web";
  sessions: number;
};

export type Note = { id: number; text: string; createdAt: string };

export type WatchStatus = { watching: boolean; path: string | null };

export type ColorScheme = "light" | "dark" | "auto";

/** The app's notification settings, held on the UI thread; the tray menu and the page both change them. */
export type NotifyStatus = { onChanges: boolean };

export type SentNotification = { id: string; title: string; body: string; at: string };

export type FsChange = {
  kind: "created" | "modified" | "deleted" | "unknown";
  /** relative to the watched root, forward slashes */
  path: string;
  at: string;
};

/** method name -> [params, result] */
export type Methods = {
  "info.get": [void, Info];
  "notes.list": [void, Note[]];
  "notes.add": [{ text: string }, Note];
  "notes.remove": [{ id: number }, void];
  /** Native OS folder dialog; the app answers this on the UI thread. null when cancelled. Not available on the web. */
  "pick.folder": [void, string | null];
  "watch.start": [{ path: string }, WatchStatus];
  "watch.stop": [void, WatchStatus];
  "watch.status": [void, WatchStatus];
  /** The page reports its colour scheme so the app's tray menu can show it. A no-op on the web. */
  "ui.theme": [{ scheme: ColorScheme }, void];
  /** System notifications; the app answers these on the UI thread. Not available on the web. */
  "notify.status": [void, NotifyStatus];
  "notify.onChanges": [{ enabled: boolean }, NotifyStatus];
  /** Sends a test notification. False when the OS showed nothing (macOS: not running as the .app). */
  "notify.test": [void, boolean];
};

/** event name -> payload */
export type Events = {
  /** Shared by everyone. */
  "notes.changed": Note[];
  /** Per session. */
  "watch.status": WatchStatus;
  "fs.change": FsChange[];
  /** The app's tray menu changed the colour scheme. */
  "ui.theme": { scheme: ColorScheme };
  "notify.status": NotifyStatus;
  "notify.sent": SentNotification;
  /** The user clicked a system notification; the app has shown the window. */
  "notify.clicked": { id: string; at: string };
};
