// The worker of app-modals.ts: one method, answered from the worker thread, so its reply crosses
// the ring and the wake into the UI thread while a modal loop holds it.

import { defineService } from "@n1h/sweetview/ipc";
import { hostService } from "@n1h/sweetview/worker";

hostService(defineService<{ echo: [string, string] }, Record<string, never>>(() => ({ methods: { echo: (kind) => `worker saw ${kind}` } })));
