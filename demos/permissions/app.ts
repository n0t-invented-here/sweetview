// A window that lists the macOS privacy permissions: what macOS says about
// each, a button that asks for it, and one that opens its pane in System
// Settings. The page reads the statuses every two seconds; everything is answered
// on the UI thread, so there is no worker.
//
//   just demos permissions app      (dev; macOS files the answers under the terminal that ran it)
//   just demos permissions open     (compile, then launch the .app, which asks in its own name)

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  automationStatus,
  installAppMenu,
  openPermissionSettings,
  permissionStatus,
  requestAutomation,
  requestFolderAccess,
  requestPermission,
  setAppIcon,
} from "@n1h/sweetview/native";
import { createWebviewApp, indexHtml, WEBVIEW_VERSION } from "@n1h/sweetview";
import pageCss from "./build/frontend/main.css" with { type: "file" };
import pageJs from "./build/frontend/main.js" with { type: "file" };
import { APP_ICON } from "./icon";
import { ROWS, type AskResult, type Events, type Methods, type Row, type RowStatus, type Snapshot } from "./rows";

const APP_NAME = "Permissions";
const BUNDLE_ID = "dev.mrowr.permissions";

// A launched .app has no console, so everything that happens also goes to a log file:
// ~/Library/Logs/sweetview-permissions.log on macOS, %LOCALAPPDATA%\sweetview-permissions.log on Windows.
const LOG_PATH =
  process.platform === "darwin" ? join(homedir(), "Library", "Logs", "sweetview-permissions.log") : join(process.env.LOCALAPPDATA ?? homedir(), "sweetview-permissions.log");
const logLine = (line: string) => {
  console.log(line);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // a read-only disk never stops the app
  }
};
console.error = (...args: unknown[]) => logLine(`error: ${args.map(String).join(" ")}`); // the library's sweetnative: lines too
process.on("uncaughtException", (err) => {
  logLine(`uncaught: ${err.name}: ${err.message}`);
  process.exit(1);
});

/** Inside Permissions.app the answers are filed under the bundle; a bare binary's go to whatever launched it. */
const bundleId = process.platform === "darwin" && process.execPath.includes(".app/Contents/MacOS/") ? BUNDLE_ID : null;

const row = (id: string): Row => {
  const found = ROWS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no row is named ${id}`);
  return found;
};

/** What each folder answered when it was asked in this run; macOS has no call that reads it without asking. */
const folderAnswers = new Map<string, RowStatus>();

const statusOf = (r: Row): RowStatus => {
  if ("permission" in r.ask) return permissionStatus(r.ask.permission);
  if ("automate" in r.ask) return automationStatus(r.ask.automate);
  return process.platform === "darwin" ? (folderAnswers.get(r.id) ?? "unknown") : "not-applicable";
};

const last = new Map<string, RowStatus>();
const snapshot = (): Snapshot => {
  const statuses: Record<string, RowStatus> = {};
  for (const r of ROWS) {
    const status = statusOf(r);
    statuses[r.id] = status;
    const before = last.get(r.id);
    if (before !== status) logLine(before === undefined ? `${r.id}: ${status}` : `${r.id}: ${before} -> ${status}`);
    last.set(r.id, status);
  }
  return { bundleId, platform: process.platform, statuses };
};

const ask = (r: Row): AskResult => {
  logLine(`asking for ${r.id}`);
  try {
    let status: RowStatus;
    if ("permission" in r.ask) status = requestPermission(r.ask.permission);
    else if ("automate" in r.ask) status = requestAutomation(r.ask.automate);
    else folderAnswers.set(r.id, (status = requestFolderAccess(r.ask.folder)));
    logLine(`asked for ${r.id}: ${status} right after`);
    return { status };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logLine(`asking for ${r.id} failed: ${error}`);
    return { error };
  }
};

const app = await createWebviewApp<Methods, Events>({
  title: APP_NAME,
  width: 620,
  height: 760,
  resizable: true,
  assets: { "index.html": indexHtml({ title: APP_NAME, body: "<main></main>" }), "main.js": pageJs, "main.css": pageCss },
  debug: process.env.WEBVIEW_DEBUG === "1",
  uiMethods: {
    "permissions.snapshot": snapshot,
    "permissions.ask": ({ id }) => ask(row(id)),
    "permissions.settings": ({ id }) => {
      const opened = openPermissionSettings(row(id).pane);
      logLine(`Settings for ${id}: ${opened ? "opened" : "not opened"}`);
      return opened;
    },
  },
});

app.window.setIcon(APP_ICON); // Windows: title bar and taskbar
setAppIcon(APP_ICON); // macOS: the Dock tile of the bare binary

// macOS only: Quit, and Cmd+C for copying a status out of the window.
installAppMenu({
  appName: APP_NAME,
  aboutText: [`${APP_NAME} 0.1.0`, "", `Bun ${Bun.version} · webview ${WEBVIEW_VERSION} · ${process.platform}/${process.arch}`, "What macOS says about each privacy permission, from @n1h/sweetview/native."].join("\n"),
});

logLine(`started as ${bundleId ?? "a bare binary"}; log at ${LOG_PATH}`);
app.run(); // the OS loop, until the window closes or Quit

logLine("quit");
process.exit(0);
