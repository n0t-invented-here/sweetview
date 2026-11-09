// The tray menu, as data. Built fresh every time it opens, so every label,
// check mark and enabled flag reads current state from `ctx`.

import type { MenuTemplate, NativeWindow } from "@n1h/sweetview/native";
import { basename } from "node:path";
import type { ColorScheme, WatchStatus } from "web-app-backend/protocol";
import { menuIcon } from "./icon";

export type TrayMenuContext = {
  appName: string;
  window: NativeWindow;
  theme: () => ColorScheme;
  setTheme: (scheme: ColorScheme) => void;
  watch: () => WatchStatus;
  pickFolderToWatch: () => void;
  stopWatching: () => void;
  notifyOnChanges: () => boolean;
  toggleNotifyOnChanges: () => void;
  sendTestNotification: () => void;
  quit: () => void;
};

const SCHEMES: ColorScheme[] = ["light", "dark", "auto"];
const capitalise = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function buildTrayMenu(ctx: TrayMenuContext): MenuTemplate {
  const watch = ctx.watch();
  return [
    { label: ctx.window.isVisible() ? "Hide Window" : "Show Window", click: () => ctx.window.toggle() },
    { type: "separator" },
    {
      label: "Theme",
      icon: menuIcon("paintpalette"),
      submenu: SCHEMES.map((scheme) => ({ label: capitalise(scheme), checked: ctx.theme() === scheme, click: () => ctx.setTheme(scheme) })),
    },
    {
      label: "Watch Folder",
      icon: menuIcon("folder"),
      submenu: [
        { label: watch.watching ? `Watching ${basename(watch.path ?? "")}` : "Not watching", enabled: false },
        { type: "separator" },
        { label: "Pick Folder…", click: ctx.pickFolderToWatch },
        { label: "Stop Watching", enabled: watch.watching, click: ctx.stopWatching },
      ],
    },
    {
      label: "Notifications",
      icon: menuIcon("bell"),
      submenu: [
        { label: "Send Test Notification", click: ctx.sendTestNotification },
        { label: "Notify on Folder Changes", checked: ctx.notifyOnChanges(), click: ctx.toggleNotifyOnChanges },
      ],
    },
    { type: "separator" },
    { label: `Quit ${ctx.appName}`, click: ctx.quit },
  ];
}
