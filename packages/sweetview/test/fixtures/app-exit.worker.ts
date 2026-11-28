// The worker of the app-exit fixture: a service with one method, and a timer
// that keeps the worker's own event loop alive for as long as the worker runs,
// as an application's worker with a file watcher or a poll does.
import { defineService } from "@n1h/sweetview/ipc";
import { hostService } from "@n1h/sweetview/worker";

setInterval(() => {}, 1000);
hostService(defineService<{ ping: [null, string] }, Record<string, never>>(() => ({ methods: { ping: () => "pong" } })));
