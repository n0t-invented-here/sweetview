// A menu-bar app: a status item (macOS) or tray icon (Windows) whose menu
// sends a system notification, now or five seconds later, so the pointer has
// left the menu by the time it lands. A window shows everything that happens;
// it opens from the menu and when a notification is clicked. The worker owns
// the five-second timer, because `run()` blocks Bun's event loop on this thread.
//
//   just demos menubar-notify app      (dev; macOS shows notifications only from the .app, see `open`)
//   just demos menubar-notify compile  (executables and the .app bundle)
//   just demos menubar-notify open     (compile, then launch the .app on macOS)

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createNotifier, createTray, Screen, setActivationPolicy, type MenuTemplate } from "@n1h/sweetview/native";
import { createApp, indexHtml, type App } from "@n1h/sweetview";
import pageCss from "./build/frontend/main.css" with { type: "file" };
import pageJs from "./build/frontend/main.js" with { type: "file" };
import { TRAY_ICON } from "./icon";
import { IDENTITY } from "./identity";
import type { Events, LogEntry, Methods } from "./service";

const APP_NAME = IDENTITY.appName;
const DELAY_SECONDS = 5;
const WINDOW_SIZE = { width: 480, height: 400 };

const LOG_PATH =
  process.platform === "darwin" ? join(homedir(), "Library", "Logs", "menubar-notify.log") : join(process.env.LOCALAPPDATA ?? homedir(), "menubar-notify.log");
const logLine = (line: string) => {
  console.log(line);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // a read-only disk never stops the app
  }
};
console.error = (...args: unknown[]) => logLine(`error: ${args.map(String).join(" ")}`);
process.on("uncaughtException", (err) => {
  logLine(`uncaught: ${err.name}: ${err.message}`);
  process.exit(1);
});

const now = () => new Date().toLocaleTimeString();
let status = "Nothing sent yet";
let sent = 0;
const history: LogEntry[] = [];

const happened = (text: string) => {
  const entry = { at: now(), text };
  history.push(entry);
  status = text;
  logLine(text);
  app.emit("log", entry);
};

setActivationPolicy("accessory"); // macOS: no Dock tile; the status item and the window are the whole app

const screen = Screen.primary().bounds;
const bounds = {
  x: screen.x + Math.round((screen.width - WINDOW_SIZE.width) / 2),
  y: screen.y + Math.round((screen.height - WINDOW_SIZE.height) / 2),
  ...WINDOW_SIZE,
};

const app: App<Methods, Events> = await createApp<Methods, Events>({
  identity: IDENTITY,
  title: APP_NAME,
  bounds,
  icon: TRAY_ICON,
  onClose: () => app.window.hide(),
  assets: {
    "index.html": indexHtml({
      title: APP_NAME,
      body: `<header><h1>${APP_NAME}</h1><p>Notifications sent and clicked</p></header>
<div class="actions"><button id="now">Send Notification Now</button><button id="later" class="secondary">Send in ${DELAY_SECONDS} Seconds</button></div>
<section><p id="empty">Nothing yet. Send one from the buttons or the menu bar.</p><ol id="log"></ol></section>`,
    }),
    "main.js": pageJs,
    "main.css": pageCss,
  },
  worker: new URL("./app-worker.ts", import.meta.url),
  debug: process.env.WEBVIEW_DEBUG === "1",
  uiMethods: {
    "notify.now": () => send(`Sent from the window at ${now()}`),
    "page.ready": () => {
      logLine("page ready");
      return history;
    },
  },
});

const tray = createTray({ tooltip: APP_NAME, icon: TRAY_ICON, menu: () => menu() });
// The toasts carry the demo's name, not Sweetview's.
const notifier = createNotifier({
  identity: IDENTITY,
  onClick: ({ id, data }) => {
    const sentAt = (data as { sentAt?: string } | undefined)?.sentAt;
    app.window.show();
    happened(`Clicked ${id}${sentAt ? `, sent at ${sentAt}` : ""}`);
  },
});

const send = (body: string) => {
  const id = `menubar-notify-${++sent}`;
  const shown = notifier.notify({ id, title: APP_NAME, body, data: { sentAt: now() } });
  happened(shown ? `Sent ${id}` : "Not shown: on macOS run the .app, not the bare binary");
};

const sendLater = () => {
  app.notify("notify.later", { seconds: DELAY_SECONDS });
  happened(`Sending in ${DELAY_SECONDS} seconds…`);
};

app.onEvent((event) => {
  if (event.name === "notify.due") send(`${event.payload.seconds} seconds after you asked`);
});

const menu = (): MenuTemplate => [
  { label: status, enabled: false },
  { type: "separator" },
  { label: "Show Window", click: () => app.window.show() },
  { label: "Send Notification Now", click: () => send(`Sent from the menu at ${now()}`) },
  { label: `Send Notification in ${DELAY_SECONDS} Seconds`, click: sendLater },
  { type: "separator" },
  { label: `Quit ${APP_NAME}`, click: () => app.quit() },
];

logLine(`started; log at ${LOG_PATH}`);
app.run(); // the OS loop, until Quit
logLine("quit");
// Until the macOS goal of the Rust rewrite, macOS runs the code it ran at the tag pre-rust-rewrite,
// which releases nothing at exit: there the demo tears down and exits as it did then.
if (process.platform === "darwin") {
  notifier.dispose();
  tray.dispose();
  app.dispose();
  process.exit(0);
}
