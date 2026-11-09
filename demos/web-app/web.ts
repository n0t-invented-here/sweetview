// The demo as a web app: Bun.serve serves the prebuilt frontend and hosts the
// same service over a WebSocket at /ws. Every browser tab is its own session.
//
//   just demos web-app serve            (PORT=4747 by default)

import { createService } from "web-app-backend";
import { wsHost } from "@n1h/sweetview/ipc-ws/server";

const APP_NAME = "Web App";
const PORT = Number(process.env.PORT ?? 4747);
// Loopback only by default: the service can watch any folder on this machine. HOST=0.0.0.0 to expose it.
const HOST = process.env.HOST ?? "127.0.0.1";
const frontend = new URL("./build/frontend/", import.meta.url);

const service = createService();
const host = wsHost(service);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${APP_NAME}</title>
<link rel="stylesheet" href="/main.css" />
</head>
<body>
<div id="root"></div>
<script type="module" src="/main.js"></script>
</body>
</html>`;

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req, server) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (pathname === "/ws") return host.upgrade(req, server) ? undefined : new Response("expected a websocket", { status: 400 });
    if (pathname === "/main.js" || pathname === "/main.css") return new Response(Bun.file(new URL(`.${pathname}`, frontend)));
    return new Response("not found", { status: 404 });
  },
  websocket: host.websocket,
});

console.log(`${APP_NAME} on http://${HOST}:${server.port}  (Ctrl+C to stop)`);

const shutdown = async () => {
  host.close();
  await service.dispose();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
