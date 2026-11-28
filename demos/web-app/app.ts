// The demo as a desktop app: a sweetview window, the service in a worker,
// IPC over the shared ring, plus a tray icon, notifications and the macOS
// menu bar from @n1h/sweetview/native.
//
//   just demos web-app app        (dev)
//   just demos web-app compile    (single executables)

import type { ColorScheme, Events, FsChange, Methods, NotifyStatus, WatchStatus } from "web-app-backend/protocol";
import { basename } from "node:path";
import { createNotifier, createTray, pickFolder, Screen, setAppIcon, setAppMenu, type Notifier } from "@n1h/sweetview/native";
import { createApp, indexHtml, WEBVIEW_VERSION, type App } from "@n1h/sweetview";
import appCss from "./build/frontend/main.css" with { type: "file" };
import appJs from "./build/frontend/main.js" with { type: "file" };
import { APP_ICON, TRAY_ICON } from "./icon";
import { IDENTITY } from "./identity";
import { buildTrayMenu } from "./tray-menu";

const APP_NAME = IDENTITY.appName;

// State this thread mirrors so the tray menu can show it without asking anyone.
let watch: WatchStatus = { watching: false, path: null };
let theme: ColorScheme = "dark";
let notifyOnChanges = false;
let notifier: Notifier | undefined;
let sentCount = 0;

const notifyStatus = (): NotifyStatus => ({ onChanges: notifyOnChanges });
const setNotifyOnChanges = (enabled: boolean) => {
  notifyOnChanges = enabled;
  app.emit("notify.status", notifyStatus());
};

/** Sends a system notification and tells the page about it. False when the OS showed nothing. */
const sendNotification = (title: string, body: string, silent = false): boolean => {
  const id = `web-app-${++sentCount}`;
  const at = new Date().toISOString();
  const shown = notifier?.notify({ id, title, body, silent, data: { at } }) ?? false;
  if (shown) app.emit("notify.sent", { id, title, body, at });
  else console.error("notification not shown (macOS: run the .app, not the bare binary)");
  return shown;
};

const sendTestNotification = (): boolean => {
  const where = process.platform === "darwin" ? "menu bar" : "tray";
  return sendNotification(APP_NAME, `Hello from the ${where} at ${new Date().toLocaleTimeString()}`);
};

const workArea = Screen.primary().workArea;
const width = Math.min(1100, workArea.width);
const height = Math.min(800, workArea.height);
const bounds = {
  x: workArea.x + Math.round((workArea.width - width) / 2),
  y: workArea.y + Math.round((workArea.height - height) / 2),
  width,
  height,
};

const app: App<Methods, Events> = await createApp<Methods, Events>({
  identity: IDENTITY,
  title: APP_NAME,
  bounds,
  icon: APP_ICON,
  assets: { "index.html": indexHtml({ title: APP_NAME }), "main.js": appJs, "main.css": appCss },
  worker: new URL("./app-worker.ts", import.meta.url),
  debug: process.env.WEBVIEW_DEBUG === "1",
  onClose: () => app.window.hide(), // the X hides to the tray; Quit lives in the tray menu
  // A modal dialog runs its own message loop, so it runs after the RPC callback returns.
  deferredUiMethods: {
    "pick.folder": () => pickFolder(app.window, "Pick a folder to watch"),
  },
  uiMethods: {
    "ui.theme": ({ scheme }) => void (theme = scheme),
    "notify.status": notifyStatus,
    "notify.onChanges": ({ enabled }) => {
      setNotifyOnChanges(enabled);
      return notifyStatus();
    },
    "notify.test": sendTestNotification,
  },
});

setAppIcon(APP_ICON); // macOS: the Dock tile (a bare binary has none otherwise)

app.onEvent((event) => {
  if (event.name === "watch.status") watch = event.payload;
  if (event.name === "fs.change" && notifyOnChanges) notifyChanges(event.payload);
});

const notifyChanges = (changes: FsChange[]) => {
  const folder = basename(watch.path ?? "") || "watched folder";
  const first = changes[0];
  const body =
    changes.length === 1 && first ? `${first.kind} ${first.path}` : `${changes.length} changes, latest ${changes.at(-1)?.path ?? ""}`;
  sendNotification(folder, body, true);
};

const tray = createTray({
  tooltip: APP_NAME,
  icon: TRAY_ICON,
  // A left click toggles the window (Windows: after the double-click interval, so a double click toggles once).
  onClick: () => app.window.toggle(),
  onDoubleClick: () => app.window.toggle(),
  menu: () =>
    buildTrayMenu({
      appName: APP_NAME,
      window: app.window,
      theme: () => theme,
      setTheme: (scheme) => {
        theme = scheme;
        app.emit("ui.theme", { scheme });
      },
      watch: () => watch,
      pickFolderToWatch: () => {
        app.window.show(); // the dialog needs a visible owner
        const path = pickFolder(app.window, "Pick a folder to watch");
        if (path) app.notify("watch.start", { path });
      },
      stopWatching: () => app.notify("watch.stop"),
      notifyOnChanges: () => notifyOnChanges,
      toggleNotifyOnChanges: () => setNotifyOnChanges(!notifyOnChanges),
      sendTestNotification,
      quit: app.quit,
    }),
});

// Clicking a notification brings the window back and the page marks that notification as clicked.
// The toasts carry the demo's name, not Sweetview's.
notifier = createNotifier({
  identity: IDENTITY,
  onClick: ({ id }) => {
    app.window.show();
    app.emit("notify.clicked", { id, at: new Date().toISOString() });
  },
});

// macOS only: webview creates NSApplication without a menu bar (no About, no Quit, no Cmd+C/V).
setAppMenu({
  appName: APP_NAME,
  aboutText: [
    `${APP_NAME} ${IDENTITY.version}`,
    "",
    `Bun ${Bun.version} · webview ${WEBVIEW_VERSION} · ${process.platform}/${process.arch}`,
    "React + Mantine inside sweetview, no server, no child processes.",
  ].join("\n"),
});

app.window.show();
app.run(); // blocks until Quit

notifier.dispose();
tray.dispose();
app.dispose();
process.exit(0);
