// The web-app demo in an Electron shell. The demo's own Service
// (web-app-backend) runs here, in Electron's main process, behind
// electronHost; the unchanged web-app page loads from app://web-app/ and talks
// to it through the preload's window.sweetviewIpc.
//
// Bundled to build/main.cjs for Node (Electron's main process is not Bun) and run as `electron .`:
//   just demos web-app-electron app
//
// WEB_APP_PROBE=1 runs ../web-app/scripts/shell-probe.js in the page once it
// has loaded, prints what the page showed as one `PROBE {...}` line, and quits.

import { app, BrowserWindow, ipcMain, net, protocol } from "electron";
import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { electronHost } from "@n1h/sweetview/ipc-electron/server";
import { createService } from "web-app-backend";

const APP_NAME = "Web App (Electron)";
const PROBE = process.env.WEB_APP_PROBE === "1";
// package.json's "main" is build/main.cjs and the shell runs `electron .`, so the app path is this demo's folder.
// (__dirname is no use here: Bun inlines it at bundle time for an ES module source.)
const build = join(app.getAppPath(), "build"); // main.cjs, preload.cjs and frontend/
const frontend = join(build, "frontend");

// The same page web.ts serves, with a policy that allows nothing but this origin.
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
<title>${APP_NAME}</title>
<link rel="stylesheet" href="/main.css" />
</head>
<body>
<div id="root"></div>
<script type="module" src="/main.js"></script>
</body>
</html>`;

// A standard, secure scheme gives the page a real origin (module scripts, fetch) without a server or file://.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(() => {
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/index.html") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    const file = normalize(join(frontend, decodeURIComponent(pathname)));
    if (!file.startsWith(frontend + sep)) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const service = createService();
  const host = electronHost(service, ipcMain);
  if (PROBE) {
    // What crossed the host, as seen from the main process.
    const call = service.call.bind(service);
    service.call = (method, params, ctx) => {
      console.log(`host: call ${method} from ${ctx.session.kind} session ${ctx.session.id}`);
      return call(method, params, ctx);
    };
    service.onEvent((name, _payload, to) => console.log(`host: event ${name} -> ${to ?? "every session"}`));
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: APP_NAME,
    icon: join(build, "icon.ico"),
    backgroundColor: "#242424",
    webPreferences: {
      preload: join(build, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.webContents.on("console-message", (event) => console.log(`page console: ${event.message}`));

  if (PROBE) {
    const probe = readFileSync(join(build, "..", "..", "web-app", "scripts", "shell-probe.js"), "utf8");
    win.webContents.once("did-finish-load", async () => {
      try {
        const report = await win.webContents.executeJavaScript(probe);
        console.log(`PROBE ${JSON.stringify(report)}`);
      } catch (err) {
        console.log(`PROBE FAILED ${(err as Error).message}`);
        process.exitCode = 1;
      }
      app.quit();
    });
  }

  void win.loadURL("app://web-app/");

  app.on("window-all-closed", async () => {
    host.dispose();
    await service.dispose();
    app.quit();
  });
});
