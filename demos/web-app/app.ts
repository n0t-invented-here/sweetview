// The demo as a desktop app: a sweetview window, the service in a worker,
// IPC over the shared ring, plus a tray icon, notifications and the macOS
// menu bar from sweetnative.
//
//   just demos web-app app        (dev)
//   just demos web-app compile    (single executables)

import type { ColorScheme, Events, FsChange, Methods, WatchStatus } from "web-app-backend/protocol";
import { basename } from "node:path";
import { createNotifier, createTray, installAppMenu, pickFolder, setAppIcon, type Notifier } from "@n1h/sweetview/native";
import { createWebviewApp, indexHtml, WEBVIEW_VERSION, type WebviewApp } from "@n1h/sweetview";
import appCss from "./build/frontend/main.css" with { type: "file" };
import appJs from "./build/frontend/main.js" with { type: "file" };
import { APP_ICON, TRAY_ICON } from "./icon";
import { buildTrayMenu } from "./tray-menu";

const APP_NAME = "Web App";

// State this thread mirrors so the tray menu can show it without asking anyone.
let watch: WatchStatus = { watching: false, path: null };
let theme: ColorScheme = "dark";
let notifyOnChanges = false;
let notifier: Notifier | undefined; // created after the tray, below

const app: WebviewApp<Methods, Events> = await createWebviewApp<Methods, Events>({
  title: APP_NAME,
  assets: { "index.html": indexHtml({ title: APP_NAME }), "main.js": appJs, "main.css": appCss },
  worker: new URL("./app-worker.ts", import.meta.url),
  debug: process.env.WEBVIEW_DEBUG === "1",
  uiMethods: {
    "pick.folder": () => pickFolder(app.windowHandle, "Pick a folder to watch"),
    "ui.theme": ({ scheme }) => void (theme = scheme),
  },
});

app.window.onCloseRequest(() => app.window.hide()); // the X hides to the tray; Quit lives in the tray menu
app.window.setIcon(APP_ICON); // Windows: title bar and taskbar
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
  notifier?.notify({ title: folder, body, silent: true });
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
        const path = pickFolder(app.windowHandle, "Pick a folder to watch");
        if (path) app.call("watch.start", { path });
      },
      stopWatching: () => app.call("watch.stop"),
      notifyOnChanges: () => notifyOnChanges,
      toggleNotifyOnChanges: () => (notifyOnChanges = !notifyOnChanges),
      sendTestNotification: () => {
        const where = process.platform === "darwin" ? "menu bar" : "tray";
        const shown = notifier?.notify({ title: APP_NAME, body: `Hello from the ${where} at ${new Date().toLocaleTimeString()}` });
        if (!shown) console.error("notification not shown (macOS: run the .app, not the bare binary)");
      },
      quit: app.quit,
    }),
});

// Clicking a notification brings the window back.
notifier = createNotifier({ onClick: () => app.window.show() });

// macOS only: webview creates NSApplication without a menu bar (no About, no Quit, no Cmd+C/V).
installAppMenu({
  appName: APP_NAME,
  aboutText: [
    `${APP_NAME} 0.1.0`,
    "",
    `Bun ${Bun.version} · webview ${WEBVIEW_VERSION} · ${process.platform}/${process.arch}`,
    "React + Mantine inside sweetview, no server, no child processes.",
  ].join("\n"),
});

app.run(); // blocks until the window closes or Quit

notifier.dispose();
tray.dispose();
process.exit(0);
