// Worker side. The worker owns the Bun event loop and the app's Service.
// Calls arrive from the UI thread by postMessage; replies and events go back
// through the shared ring, with webview_dispatch as the wakeup.
//
//   // app-worker.ts
//   import { hostService } from "@n1h/sweetview/worker";
//   import { createService } from "my-backend";
//   hostService(createService());

import { FFIType, dlopen, type Pointer } from "bun:ffi";
import type { CallFrame, EventMap, Frame, MethodMap, ReplyFrame, Service } from "./ipc";
import { WEBVIEW_SESSION, type WorkerMessage } from "./messages";
import { Ring } from "./ring";

declare const self: Worker;

const dispatchLibs = new Map<string, (w: Pointer, fn: Pointer, arg: Pointer | null) => void>();

function dispatchCall(libPath: string): (w: Pointer, fn: Pointer, arg: Pointer | null) => void {
  const cached = dispatchLibs.get(libPath);
  if (cached) return cached;
  const lib = dlopen(libPath, {
    webview_dispatch: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  });
  const fn = lib.symbols.webview_dispatch as (w: Pointer, fn: Pointer, arg: Pointer | null) => void;
  dispatchLibs.set(libPath, fn);
  return fn;
}

/**
 * Serializes `frame` and writes it into `ring`, waking the consumer when
 * needed. Never throws on oversized or unserializable replies: sends a compact
 * error reply frame instead so RPC callers never hang.
 */
export function writeWorkerFrame(
  ring: Ring,
  frame: Frame,
  wake: () => void,
  encoder: TextEncoder = new TextEncoder(),
): void {
  try {
    ring.write(encoder.encode(JSON.stringify(frame)));
    if (ring.claimWakeup()) wake();
    return;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (frame.kind !== "reply") {
      console.error(`sweetview worker: ${frame.kind === "event" ? `event ${frame.name}` : "frame"} could not be sent:`, reason);
      return;
    }
    // Fall back to a compact error reply guaranteed to fit in the ring.
    const prefix = "sweetview worker: reply could not be sent: ";
    const maxBytes = Math.max(0, ring.capacity - 4);
    let error = `${prefix}${reason}`;
    let fallback: ReplyFrame = { kind: "reply", seq: frame.seq, ok: false, error };
    let encoded = encoder.encode(JSON.stringify(fallback));
    if (encoded.length > maxBytes) {
      const overhead = encoder.encode(JSON.stringify({ kind: "reply", seq: frame.seq, ok: false, error: "" } satisfies ReplyFrame)).length;
      const room = Math.max(0, maxBytes - overhead - 3);
      error = room > 0 ? `${error.slice(0, room)}...` : "";
      fallback = { kind: "reply", seq: frame.seq, ok: false, error };
      encoded = encoder.encode(JSON.stringify(fallback));
    }
    try {
      ring.write(encoded);
      if (ring.claimWakeup()) wake();
    } catch (fallbackErr) {
      console.error("sweetview worker: fallback error reply could not be written:", fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
    }
  }
}

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
    writeWorkerFrame(ring, frame, wake, encoder);
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
      const dispatch = dispatchCall(msg.libPath);
      const handlePtr = msg.webviewHandle as Pointer;
      const fn = msg.drainCallbackPtr as Pointer;
      wake = () => dispatch(handlePtr, fn, null);
      const queued = beforeInit;
      beforeInit = [];
      for (const frame of queued) send(frame);
      return;
    }
    void handle(msg);
  };
}
