// The contract between the page, the UI thread and the worker, and the
// worker's service: it owns the Bun event loop, so the delayed notification
// is its setTimeout; when it is due, the UI thread shows the notification.

import { defineService, type Service } from "@n1h/sweetview/ipc";

export type LogEntry = { at: string; text: string };

/** method name -> [params, result] */
export type Methods = {
  /** Answered on the UI thread: shows a notification now. */
  "notify.now": [void, void];
  /** Worker: emits `notify.due` after `seconds`. A newer request replaces an older one still pending. */
  "notify.later": [{ seconds: number }, void];
  /** Answered on the UI thread when the page has loaded: everything that happened so far. */
  "page.ready": [void, LogEntry[]];
};

export type Events = {
  /** Something happened: a notification sent, clicked, or scheduled. */
  log: LogEntry;
  /** The worker's timer ran out; the UI thread sends the notification. */
  "notify.due": { seconds: number };
};

export function createService(): Service<Methods, Events> {
  let pending: ReturnType<typeof setTimeout> | undefined;
  return defineService<Methods, Events>((emit) => ({
    methods: {
      "notify.now": () => {
        throw new Error("notify.now is answered on the UI thread");
      },
      "page.ready": () => {
        throw new Error("page.ready is answered on the UI thread");
      },
      "notify.later": ({ seconds }) => {
        clearTimeout(pending);
        pending = setTimeout(() => {
          pending = undefined;
          emit("notify.due", { seconds });
        }, seconds * 1000);
      },
    },
  }));
}
