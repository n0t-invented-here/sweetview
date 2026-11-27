// The worker of the app rows-desktop.ts makes: `hostService` answers the
// page's calls and `hostRequestHandler` answers its requests that no asset
// does, as the guide's rows for `@n1h/sweetview/worker` say.

import { defineService } from "@n1h/sweetview/ipc";
import { hostRequestHandler, hostService } from "@n1h/sweetview/worker";

hostService(defineService<{ echo: [string, string] }, Record<string, never>>(() => ({ methods: { echo: (text) => `worker: ${text}` } })));
hostRequestHandler((request) => new Response(`worker answered ${new URL(request.url).pathname}`, { headers: { "content-type": "text/plain" } }));
