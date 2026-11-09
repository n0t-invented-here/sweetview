// Worker side. The worker owns the Bun event loop and the app's Service.
// Calls arrive from the UI thread by postMessage; replies and events go back
// through the shared ring, with webview_dispatch as the wakeup.
//
//   // app-worker.ts
//   import { hostService } from "@n1h/sweetview/worker";
//   import { createService } from "my-backend";
//   hostService(createService());

import { FFIType, dlopen, type Pointer } from "bun:ffi";
import type { CallFrame, EventMap, Frame, MethodMap, Service } from "./ipc";
import { WEBVIEW_SESSION, type WorkerMessage } from "./messages";
import { Ring } from "./ring";

declare const self: Worker;

export function hostService<M extends MethodMap, E extends EventMap>(service: Service<M, E>): void {
  let ring: Ring | undefined;
  let wake: (() => void) | undefined;
  let beforeInit: Frame[] = [];
  const encoder = new TextEncoder();
  const ctx = { session: WEBVIEW_SESSION };

  function send(frame: Frame) {
    if (!ring || !wake) {
      beforeInit.push(frame);
      return;
    }
    ring.write(encoder.encode(JSON.stringify(frame)));
    if (ring.claimWakeup()) wake();
  }

  service.onEvent((name, payload, to) => {
    if (to !== undefined && to !== WEBVIEW_SESSION.id) return;
    send({ kind: "event", name, payload });
  });

  async function handle(frame: CallFrame) {
    try {
      const result = await service.call(frame.method as keyof M & string, frame.params as never, ctx);
      if (frame.seq !== null) send({ kind: "reply", seq: frame.seq, ok: true, result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (frame.seq !== null) send({ kind: "reply", seq: frame.seq, ok: false, error });
      else console.error(`${frame.method} failed:`, error);
    }
  }

  self.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;
    if (msg.kind === "init") {
      ring = new Ring(msg.ring);
      const lib = dlopen(msg.libPath, {
        webview_dispatch: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
      });
      const handle = msg.webviewHandle as Pointer;
      const fn = msg.drainCallbackPtr as Pointer;
      wake = () => lib.symbols.webview_dispatch(handle, fn, null);
      const queued = beforeInit;
      beforeInit = [];
      for (const frame of queued) {
        try {
          send(frame);
        } catch (err) {
          console.error("sweetview worker: a queued frame could not be sent:", (err as Error).message); // the rest still go
        }
      }
      return;
    }
    void handle(msg);
  };
}
