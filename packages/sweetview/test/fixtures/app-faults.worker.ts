// The worker of app-faults.ts: a method that emits two events before it answers, and one that
// crashes the worker a moment after it answers.

import { defineService } from "@n1h/sweetview/ipc";
import { hostService } from "@n1h/sweetview/worker";

type Methods = { ticks: [null, string]; crash: [null, null] };
type Events = { tick: number };

hostService(
  defineService<Methods, Events>((emit) => ({
    methods: {
      ticks: () => {
        emit("tick", 1);
        emit("tick", 2);
        return "ticked";
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
