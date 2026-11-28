// UI thread: a tiny borderless, topmost, see-through window that the page
// drives around the screen, plus a framed settings window (hidden until the
// tray opens it) with a React page in it. One OS loop runs both.
//
//   just demos desktop-pet app        (dev; WEBVIEW_DEBUG=1 for devtools and the frame rate, PET=cat to pick the launch animal)
//   just demos desktop-pet compile    (demos/desktop-pet/dist/)

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHitRelay, createNotifier, createTray, Screen, setAppIcon, unpackRegions, Window, type MenuTemplate, type Notifier } from "@n1h/sweetview/native";
import { indexHtml, WebView, windowChromeMethods, type Asset } from "@n1h/sweetview";
import { SettingsStore } from "@n1h/sweetview/settings-store";
import petCss from "./build/frontend/main.css" with { type: "file" };
import petJs from "./build/frontend/main.js" with { type: "file" };
import settingsCss from "./build/settings/main.css" with { type: "file" };
import settingsJs from "./build/settings/main.js" with { type: "file" };
import { WINDOW_SIZE } from "./frontend/config";
import { PET_MODEL_FILES, PET_TEXTURE_FILE } from "./pet-models";
import { PET_TEXTURE_PATH, PETS, petLabel, petModelPath, randomPet, type Pet } from "./pets";
import type { Events, Methods, UiMethods } from "./service";
import { petIcon } from "./icon";
import { IDENTITY } from "./identity";
import { DEFAULT_SETTINGS, sanitize, type Settings } from "./settings";

const APP_NAME = IDENTITY.appName;
const DEBUG = process.env.WEBVIEW_DEBUG === "1";
const STILL = process.env.PET_STILL === "1";
// The settings window's chrome: the page draws it (frameless, transparent, our look) unless PET_OS_FRAME=1 asks for the OS's frame.
const SETTINGS_CHROME: "page" | "os" = process.env.PET_OS_FRAME === "1" ? "os" : "page";

// ---- state this thread owns ----------------------------------------------------

const settingsStore = new SettingsStore<Settings>({ app: "sweetview-pet", defaults: DEFAULT_SETTINGS, sanitize });
let settings: Settings = settingsStore.load();

const LOG_PATH = join(dirname(settingsStore.path), "pet.log");
let notifier: Notifier | undefined;
let notified = false;
const logFault = (line: string) => {
  console.error(line);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // a read-only disk never stops the app
  }
  if (!notified && notifier?.notify({ title: `${APP_NAME}: the pet cannot be shown`, body: `${line}\n(${LOG_PATH})` })) notified = true;
};
process.on("uncaughtException", (err) => {
  logFault(`uncaught on the UI thread: ${err.name}: ${err.message}`);
  process.exit(1);
});
const isPet = (name: string | undefined): name is Pet => (PETS as readonly string[]).includes(name ?? "");
let pet: Pet = isPet(process.env.PET) ? process.env.PET : randomPet();

// ---- the pet window ----------------------------------------------------------------

const primary = Screen.primary();
const area = primary.bounds;
const size = Math.round(WINDOW_SIZE * settings.scale);
const overlay = new Window({
  identity: IDENTITY,
  title: APP_NAME,
  frame: false,
  transparent: true,
  topmost: true,
  hideFromTaskbar: true,
  noActivate: true,
  bounds: {
    x: area.x + Math.round(area.width * 0.6),
    y: area.y + area.height - size - Math.round(settings.bottom * primary.scale),
    width: size,
    height: size,
  },
});
setAppIcon(petIcon(pet)); // macOS: the Dock tile, when the app is not an accessory

const petAssets: Record<string, Asset> = {
  "index.html": indexHtml({ title: APP_NAME, body: '<canvas id="pet"></canvas>' }),
  "main.js": petJs,
  "main.css": petCss,
  [PET_TEXTURE_PATH]: PET_TEXTURE_FILE,
  ...Object.fromEntries(PETS.map((p) => [petModelPath(p), PET_MODEL_FILES[p]])),
};

// ---- the settings window ---------------------------------------------------------

const SETTINGS_SIZE = { width: 460, height: 560 };
const settingsBounds = {
  x: area.x + Math.round((area.width - SETTINGS_SIZE.width) / 2),
  y: area.y + Math.round((area.height - SETTINGS_SIZE.height) / 2),
  ...SETTINGS_SIZE,
};
const settingsWindow =
  SETTINGS_CHROME === "os"
    ? new Window({
        identity: IDENTITY,
        frame: true,
        appearance: "dark",
        title: `${APP_NAME} Settings`,
        bounds: settingsBounds,
        icon: petIcon(pet),
        onClose: () => settingsWindow.hide(),
      })
    : new Window({
        identity: IDENTITY,
        frame: false,
        transparent: true,
        title: `${APP_NAME} Settings`,
        bounds: settingsBounds,
        icon: petIcon(pet),
        onClose: () => settingsWindow.hide(),
      });

const settingsAssets: Record<string, Asset> = {
  "settings/index.html": indexHtml({ title: `${APP_NAME} Settings` }),
  "settings/main.js": settingsJs,
  "settings/main.css": settingsCss,
};

// ---- what both pages may ask this thread --------------------------------------------

const broadcast = <N extends keyof Events & string>(name: N, payload: Events[N]) => {
  petView.emit(name, payload);
  settingsView.emit(name, payload);
};

const choosePet = (next: Pet) => {
  pet = next;
  broadcast("pet.select", next);
  const icon = petIcon(next);
  tray.setIcon(icon);
  settingsWindow.setIcon(icon);
  setAppIcon(icon);
};

const hits = createHitRelay(overlay, (probe) => petView.emit("hit.probe", probe));
hits.setEnabled(settings.clickThrough);

const changeSettings = (patch: Partial<Settings>): Settings => {
  settings = sanitize({ ...settings, ...patch });
  settingsStore.save(settings);
  hits.setEnabled(settings.clickThrough);
  broadcast("settings.changed", settings);
  return settings;
};

const uiMethods: { [K in keyof UiMethods]: (params: UiMethods[K][0]) => UiMethods[K][1] } = {
  "pet.move": ({ x, y }) => overlay.moveTo(x, y),
  "pet.resize": ({ width, height }) => overlay.resize(width, height),
  "hit.regions": (flat) => hits.setRegions(unpackRegions(flat)),
  "hit.answer": hits.answer,
  "screen.area": () => ({ ...Screen.of(overlay).bounds, scale: overlay.scale(), debug: DEBUG, still: STILL }),
  "screen.at": (point) => ({ ...Screen.at(point).bounds, scale: overlay.scale(), debug: DEBUG, still: STILL }),
  "pet.current": () => pet,
  "pet.choose": choosePet,
  "settings.get": () => settings,
  "settings.set": changeSettings,
  "debug.log": (line) => console.log(line),
  "pet.fault": (line) => logFault(`page: ${line}`),
  ...windowChromeMethods(settingsWindow, { chrome: SETTINGS_CHROME }),
  "pet.quit": () => petView.quit(),
};

const petView: WebView<Methods, Events> = await WebView.attach<Methods, Events>(overlay, {
  title: APP_NAME,
  assets: petAssets,
  worker: new URL("./app-worker.ts", import.meta.url),
  debug: DEBUG,
  uiMethods,
});

const settingsView: WebView<Methods, Events> = await WebView.attach<Methods, Events>(settingsWindow, {
  title: `${APP_NAME} Settings`,
  assets: settingsAssets,
  index: "settings/index.html",
  debug: DEBUG,
  uiMethods,
});

overlay.show();
hits.apply();
if (process.env.PET_SETTINGS === "1") settingsWindow.show();

// ---- tray ------------------------------------------------------------------------------

const petMenu = (): MenuTemplate => PETS.map((p) => ({ label: petLabel(p), icon: petIcon(p), checked: p === pet, click: () => choosePet(p) }));

const tray = createTray({
  tooltip: APP_NAME,
  icon: petIcon(pet),
  onClick: () => settingsWindow.show(),
  menu: () => [
    { label: "Settings…", click: () => settingsWindow.show() },
    { label: "Pet", icon: petIcon(pet), submenu: petMenu() },
    { label: "Click through", checked: settings.clickThrough, click: () => changeSettings({ clickThrough: !settings.clickThrough }) },
    { label: "Bring to front", click: () => overlay.setTopmost(true) },
    { type: "separator" },
    { label: `Quit ${APP_NAME}`, click: () => petView.quit() },
  ],
});
notifier = createNotifier({ identity: IDENTITY }); // the toasts carry the demo's name, not Sweetview's

petView.run();
// Until the macOS goal of the Rust rewrite, macOS runs the code it ran at the tag pre-rust-rewrite,
// which releases nothing at exit: there the demo tears down and exits as it did then.
if (process.platform === "darwin") {
  notifier.dispose();
  tray.dispose();
  settingsView.dispose();
  settingsWindow.dispose();
  overlay.dispose();
  process.exit(0);
}
