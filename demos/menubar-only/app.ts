// A menu-bar app with no window: a status item (macOS) or tray icon (Windows)
// and its menu, nothing else. No webview, no worker: `runEventLoop` pumps the
// OS loop from Bun's own event loop, so `setInterval` works on this thread;
// the menu's first line counts the seconds since launch and the tooltip
// shows the time once a second while "Clock in Tooltip" is checked.
//
//   just demos menubar-only app      (dev)
//   just demos menubar-only compile  (executables and the .app bundle)
//   just demos menubar-only open     (compile, then launch the .app on macOS)

import { createTray, runEventLoop, setActivationPolicy, type MenuTemplate } from "@n1h/sweetview/native";
import { TRAY_ICON } from "./icon";

const APP_NAME = "Menubar Only";
const startedAt = Date.now();
let clockInTooltip = false;

const upFor = () => {
  const s = Math.round((Date.now() - startedAt) / 1000);
  return s < 60 ? `Up for ${s} s` : `Up for ${Math.floor(s / 60)} min ${s % 60} s`;
};

setActivationPolicy("accessory"); // macOS: no Dock tile and no app menu; the status item is the whole app
const quit = new AbortController();

const menu = (): MenuTemplate => [
  { label: upFor(), enabled: false },
  { type: "separator" },
  { label: "Clock in Tooltip", checked: clockInTooltip, click: () => (clockInTooltip = !clockInTooltip) },
  { type: "separator" },
  { label: `Quit ${APP_NAME}`, click: () => quit.abort() },
];

const tray = createTray({ tooltip: APP_NAME, icon: TRAY_ICON, menu });

// A plain Bun timer on the UI thread: it runs because runEventLoop leaves Bun's event loop in charge.
const clock = setInterval(() => tray.setTooltip(clockInTooltip ? `${APP_NAME} · ${new Date().toLocaleTimeString()}` : APP_NAME), 1000);

await runEventLoop({ signal: quit.signal });

clearInterval(clock);
tray.dispose();
process.exit(0);
