// A menu-bar app with no window: a status item (macOS) or tray icon (Windows)
// whose menu sends a system notification, now or a few seconds later, so the
// pointer has left the menu by the time it lands. No webview, no worker:
// `runEventLoop` pumps the OS loop from Bun's own event loop, so `setTimeout`
// works on this thread.
//
//   just demos menubar-notify app      (dev; macOS shows notifications only from the .app, see `open`)
//   just demos menubar-notify compile  (executables and the .app bundle)
//   just demos menubar-notify open     (compile, then launch the .app on macOS)

import { createNotifier, createTray, runEventLoop, setActivationPolicy, type MenuTemplate } from "@n1h/sweetview/native";
import { TRAY_ICON } from "./icon";

const APP_NAME = "Menubar Notify";
const DELAY_SECONDS = 5;

let status = "No notification sent yet";
let pending: ReturnType<typeof setTimeout> | undefined;
let sent = 0;
const now = () => new Date().toLocaleTimeString();

setActivationPolicy("accessory"); // macOS: no Dock tile and no app menu; the status item is the whole app
const quit = new AbortController();

const tray = createTray({ tooltip: APP_NAME, icon: TRAY_ICON, menu: () => menu() });
// Windows: the notifier hangs off the tray, so it comes after.
// A click says which notification it was and what it carried: here the time it was sent.
const notifier = createNotifier({
  onClick: ({ id, data }) => (status = `Clicked ${id} (sent at ${(data as { sentAt: string }).sentAt}) at ${now()}`),
});

const send = (body: string) => {
  pending = undefined;
  const shown = notifier.notify({ id: `menubar-notify-${++sent}`, title: APP_NAME, body, data: { sentAt: now() } });
  status = shown ? `Sent at ${now()}` : "Not shown: on macOS run the .app, not the bare binary";
  if (!shown) console.error(status);
};

const sendLater = () => {
  clearTimeout(pending);
  status = `Sending in ${DELAY_SECONDS} seconds…`;
  pending = setTimeout(() => send(`${DELAY_SECONDS} seconds after you clicked the menu`), DELAY_SECONDS * 1000);
};

const menu = (): MenuTemplate => [
  { label: status, enabled: false },
  { type: "separator" },
  { label: "Send Notification Now", click: () => send(`Sent from the menu at ${now()}`) },
  { label: `Send Notification in ${DELAY_SECONDS} Seconds`, click: sendLater },
  { type: "separator" },
  { label: `Quit ${APP_NAME}`, click: () => quit.abort() },
];

await runEventLoop({ signal: quit.signal });

clearTimeout(pending);
notifier.dispose();
tray.dispose();
process.exit(0);
