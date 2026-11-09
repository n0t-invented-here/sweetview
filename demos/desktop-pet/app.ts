// UI thread: a tiny borderless, topmost, see-through window that the page
// drives around the screen, plus a framed settings window (hidden until the
// tray opens it) with a React page in it. One OS loop runs both.
//
//   just demos desktop-pet app        (dev; WEBVIEW_DEBUG=1 for devtools and the frame rate, PET=cat to pick the launch animal)
//   just demos desktop-pet compile    (demos/desktop-pet/dist/)

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHitRelay, createNotifier, createOverlayWindow, createTray, setAppIcon, unpackRegions, type MenuTemplate, type Notifier } from "@n1h/sweetview/native";
import { createWebviewApp, indexHtml, windowChromeMethods, type Asset, type WebviewApp } from "@n1h/sweetview";
import { createSettingsStore } from "@n1h/sweetview/settings-store";
import petCss from "./build/frontend/main.css" with { type: "file" };
import petJs from "./build/frontend/main.js" with { type: "file" };
import settingsCss from "./build/settings/main.css" with { type: "file" };
import settingsJs from "./build/settings/main.js" with { type: "file" };
import { WINDOW_SIZE } from "./frontend/config";
import { PET_MODEL_FILES, PET_TEXTURE_FILE } from "./pet-models";
import { PET_TEXTURE_PATH, PETS, petLabel, petModelPath, randomPet, type Pet } from "./pets";
import type { Events, Methods, UiMethods } from "./service";
import { petIcon } from "./icon";
import { DEFAULT_SETTINGS, sanitize, type Settings } from "./settings";

const APP_NAME = "Pet";
const DEBUG = process.env.WEBVIEW_DEBUG === "1";
const STILL = process.env.PET_STILL === "1";
// The settings window's chrome: the page draws it (frameless, transparent, our look) unless PET_OS_FRAME=1 asks for the OS's frame.
const SETTINGS_CHROME: "page" | "os" = process.env.PET_OS_FRAME === "1" ? "os" : "page";

// ---- state this thread owns ----------------------------------------------------

// settings.json under the app-data folder (%APPDATA%\sweetview-pet, ~/Library/Application Support/sweetview-pet), read once here.
const settingsStore = createSettingsStore<Settings>({ app: "sweetview-pet", defaults: DEFAULT_SETTINGS, sanitize });
let settings: Settings = settingsStore.load();

// pet.log beside settings.json: what went wrong in the page (pet.fault) or on this thread, for a
// machine where the pet never appears and the console is hidden. The first fault is also shown
// as a notification once the tray exists.
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
// Random at launch; PET=<name> (one of pets.ts) picks instead, for testing a particular animal.
const isPet = (name: string | undefined): name is Pet => (PETS as readonly string[]).includes(name ?? "");
let pet: Pet = isPet(process.env.PET) ? process.env.PET : randomPet();

// ---- the pet window ----------------------------------------------------------------

// Our own window: no frame, always on top, off the taskbar and Dock, never
// focused, composed with the page's alpha. Made before the browser so WebView2
// sees a transparent host from the start.
const overlay = createOverlayWindow({ title: APP_NAME, transparent: true });
setAppIcon(petIcon(pet)); // macOS: the Dock tile, when the app is not an accessory
const area = overlay.screen(); // the whole monitor: the pet stands on its bottom edge (minus `bottom`), over the taskbar or Dock
const size = Math.round(WINDOW_SIZE * settings.scale);
overlay.setBounds({ x: area.x + Math.round(area.width * 0.6), y: area.y + area.height - size - Math.round(settings.bottom * overlay.scale()), width: size, height: size }); // `bottom` is CSS pixels

// The page and everything it fetches, served by the library at the page's own
// origin; the models are embedded in the executable and read from there.
const petAssets: Record<string, Asset> = {
  "index.html": indexHtml({ title: APP_NAME, body: '<canvas id="pet"></canvas>' }),
  "main.js": petJs,
  "main.css": petCss,
  [PET_TEXTURE_PATH]: PET_TEXTURE_FILE,
  ...Object.fromEntries(PETS.map((p) => [petModelPath(p), PET_MODEL_FILES[p]])),
};

// ---- the settings window ---------------------------------------------------------

const SETTINGS_SIZE = { width: 460, height: 560 };
const settingsBounds = { x: area.x + Math.round((area.width - SETTINGS_SIZE.width) / 2), y: area.y + Math.round((area.height - SETTINGS_SIZE.height) / 2), ...SETTINGS_SIZE };
const settingsWindow =
  SETTINGS_CHROME === "os"
    ? createOverlayWindow({ frame: true, dark: true, title: `${APP_NAME} Settings`, bounds: settingsBounds, icon: petIcon(pet) })
    : // Frameless and see-through: the page draws the card, title bar, buttons and resize handles; a normal window otherwise. The icon still shows on the taskbar and in Alt+Tab.
      createOverlayWindow({ transparent: true, topmost: false, hideFromTaskbar: false, noActivate: false, title: `${APP_NAME} Settings`, bounds: settingsBounds, icon: petIcon(pet) });

const settingsAssets: Record<string, Asset> = {
  "settings/index.html": indexHtml({ title: `${APP_NAME} Settings` }),
  "settings/main.js": settingsJs,
  "settings/main.css": settingsCss,
};

// ---- what both pages may ask this thread --------------------------------------------

/** Push to both pages, so the tray, the settings page and the pet always agree. */
const broadcast = <N extends keyof Events & string>(name: N, payload: Events[N]) => {
  petApp.emit(name, payload);
  settingsApp.emit(name, payload);
};

const choosePet = (next: Pet) => {
  pet = next;
  broadcast("pet.select", next);
  // The icons are the pet: tray, settings window and Dock follow the choice.
  const icon = petIcon(next);
  tray.setIcon(icon);
  settingsWindow.setIcon(icon);
  setAppIcon(icon);
};

// Click-through, exact to the model: the page's polygons are the coarse answer; inside one the page is asked
// (hit.probe) for a triangle pick and replies with hit.answer. The relay keeps the regions, the pending probe and the on/off switch.
const hits = createHitRelay(overlay, (probe) => petApp.emit("hit.probe", probe));
hits.setEnabled(settings.clickThrough);

const changeSettings = (patch: Partial<Settings>): Settings => {
  settings = sanitize({ ...settings, ...patch });
  settingsStore.save(settings);
  hits.setEnabled(settings.clickThrough);
  broadcast("settings.changed", settings); // the pet page resizes and moves itself from this
  return settings;
};

const uiMethods: { [K in keyof UiMethods]: (params: UiMethods[K][0]) => UiMethods[K][1] } = {
  "pet.move": ({ x, y }) => overlay.moveTo(x, y),
  "pet.resize": ({ width, height }) => overlay.resize(width, height),
  "hit.regions": (flat) => hits.setRegions(unpackRegions(flat)),
  "hit.answer": hits.answer,
  "screen.area": () => ({ ...overlay.screen(), scale: overlay.scale(), debug: DEBUG, still: STILL }),
  "screen.at": (point) => ({ ...overlay.screenAt(point), scale: overlay.scale(), debug: DEBUG, still: STILL }),
  "pet.current": () => pet,
  "pet.choose": choosePet,
  "settings.get": () => settings,
  "settings.set": changeSettings,
  "debug.log": (line) => console.log(line),
  "pet.fault": (line) => logFault(`page: ${line}`),
  // The settings window's page-drawn chrome (window.*); its X hides the window, the tray shows it again.
  ...windowChromeMethods(settingsWindow, { chrome: SETTINGS_CHROME }),
  "pet.quit": () => petApp.quit(),
};

const petApp: WebviewApp<Methods, Events> = await createWebviewApp<Methods, Events>({
  title: APP_NAME,
  window: overlay.handle,
  // The library takes these as DIPs on Windows; the overlay is sized in physical pixels.
  width: size / overlay.scale(),
  height: size / overlay.scale(),
  assets: petAssets,
  worker: new URL("./app-worker.ts", import.meta.url),
  debug: DEBUG,
  transparent: true,
  uiMethods,
});

// No worker: everything the settings page calls is answered here. Shares the OS loop petApp.run() spins.
const settingsApp: WebviewApp<Methods, Events> = await createWebviewApp<Methods, Events>({
  title: `${APP_NAME} Settings`,
  window: settingsWindow.handle,
  width: SETTINGS_SIZE.width / settingsWindow.scale(),
  height: SETTINGS_SIZE.height / settingsWindow.scale(),
  assets: settingsAssets,
  index: "settings/index.html",
  resizable: SETTINGS_CHROME === "os", // framed: width/height are the client area and the library fits the frame; frameless: the page's handles resize it
  transparent: SETTINGS_CHROME === "page",
  debug: DEBUG,
  uiMethods,
});

overlay.show();
hits.apply();
if (process.env.PET_SETTINGS === "1") settingsWindow.show(); // open the settings window at launch, for testing it

// ---- tray ------------------------------------------------------------------------------

const petMenu = (): MenuTemplate => PETS.map((p) => ({ label: petLabel(p), icon: petIcon(p), checked: p === pet, click: () => choosePet(p) }));

const tray = createTray({
  tooltip: APP_NAME,
  icon: petIcon(pet),
  // Windows: a left click opens Settings (right click is the menu). macOS: the menu opens on any click, so this never fires there.
  onClick: () => settingsWindow.show(),
  menu: () => [
    { label: "Settings…", click: () => settingsWindow.show() },
    { label: "Pet", icon: petIcon(pet), submenu: petMenu() },
    { label: "Click through", checked: settings.clickThrough, click: () => changeSettings({ clickThrough: !settings.clickThrough }) },
    { label: "Bring to front", click: () => overlay.setTopmost(true) },
    { type: "separator" },
    { label: `Quit ${APP_NAME}`, click: petApp.quit },
  ],
});
notifier = createNotifier(); // Windows shows notifications through the tray icon, so after the tray

petApp.run();
tray.dispose();
process.exit(0);
