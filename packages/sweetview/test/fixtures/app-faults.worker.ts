// The worker of app-faults.ts: a method that emits two events before it answers, and one that
// crashes the worker a moment after it answers.

import { defineService } from "@n1h/sweetview/ipc";
import { hostService } from "@n1h/sweetview/worker";

type Methods = {
  ticks: [null, string];
  crash: [null, null];
  "crash.afterEvent": [null, null];
  "throws.unreadable": [null, null];
  "throws.noPrototype": [null, null];
};
type Events = { tick: number };

hostService(
  defineService<Methods, Events>((emit) => ({
    methods: {
      ticks: () => {
        emit("tick", 1);
        emit("tick", 2);
        return "ticked";
      },
      // Values that cannot be read the usual way (review 3, item 5): each call still gets its error reply.
      "throws.unreadable": () => {
        throw new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("getPrototypeOf trap");
            },
          },
        );
      },
      "throws.noPrototype": () => {
        throw Object.create(null);
      },
      // An event, then the worker's own uncaught exception: the event is queued before the crash.
      "crash.afterEvent": () => {
        emit("tick", 99);
        setTimeout(() => {
          throw new Error("worker crash after an event");
        }, 0);
        return null;
      },
      crash: () => {
        setTimeout(() => {
          throw new Error("worker crash");
        }, 50);
        return null;
      },
    },
  })),
);
