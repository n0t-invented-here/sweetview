// The worker of callback-faults.ts: a method that throws (its call is rejected, and the UI thread
// learns of it from the reply), and one that crashes the worker a moment after it answers.

import { defineService } from "@n1h/sweetview/ipc";
import { hostService } from "@n1h/sweetview/worker";

type Methods = { "fault.reject": [string, null]; "fault.crash": [string, null] };

hostService(
  defineService<Methods, Record<string, never>>(() => ({
    methods: {
      "fault.reject": (label) => {
        throw new Error(`${label}: worker method`);
      },
      "fault.crash": (label) => {
        setTimeout(() => {
          throw new Error(`${label}: worker crash`);
        }, 50);
        return null;
      },
    },
  })),
);
