// Worker side. The worker owns the Bun event loop and the app's Service.
// Calls arrive from the UI thread by postMessage; replies and events go back
// through the shared ring, with webview_dispatch as the wakeup.
//
//   // app-worker.ts
//   import { hostService } from "@n1h/sweetview/worker";
//   import { createService } from "my-backend";
//   hostService(createService());

import { FFIType, dlopen, type Pointer } from "bun:ffi";
import type { CallFrame, ChunkFrame, EventMap, Frame, MethodMap, ReplyFrame, Service } from "./ipc";
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
 * Encodes `{ kind: "reply", seq, ok: false, error }` clamped by exact UTF-8
 * JSON byte length (accounting for JSON escaping such as quotes, NUL bytes,
 * and multibyte UTF-8 characters) so it always fits within `maxBytes`.
 */
function encodeClampedErrorReply(seq: string, message: string, maxBytes: number, encoder: TextEncoder): Uint8Array | null {
  const make = (error: string) => encoder.encode(JSON.stringify({ kind: "reply", seq, ok: false, error } satisfies ReplyFrame));
  const full = make(message);
  if (full.length <= maxBytes) return full;

  const empty = make("");
  if (empty.length > maxBytes) return null;

  const withEllipsis = (len: number) => {
    let end = len;
    if (end > 0 && end < message.length) {
      const code = message.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    return make(end > 0 ? `${message.slice(0, end)}...` : "...");
  };

  if (withEllipsis(0).length > maxBytes) return empty;

  let lo = 0;
  let hi = message.length;
  let best = withEllipsis(0);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = withEllipsis(mid);
    if (candidate.length <= maxBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

let nextChunkId = 1;

/**
 * Attempts to stream `payloadBytes` across sequential ChunkFrame records in `ring`.
 * Returns true if chunking succeeded, false if the ring is too tiny even for chunk envelopes.
 */
function writeChunked(ring: Ring, payloadBytes: Uint8Array, wake: () => void, encoder: TextEncoder): boolean {
  const maxBytes = ring.capacity - 4;
  const id = nextChunkId++;
  const b64 = Buffer.from(payloadBytes).toString("base64");
  // Estimate envelope overhead conservatively (up to 10-digit index/total).
  const probeOverhead = encoder.encode(
    JSON.stringify({ kind: "chunk", id, index: 9999999, total: 9999999, data: "" } satisfies ChunkFrame),
  ).length;
  const maxDataLen = maxBytes - probeOverhead;
  if (maxDataLen < 16) return false;

  const total = Math.max(1, Math.ceil(b64.length / maxDataLen));
  for (let index = 0; index < total; index++) {
    const data = b64.slice(index * maxDataLen, (index + 1) * maxDataLen);
    const chunkBytes = encoder.encode(JSON.stringify({ kind: "chunk", id, index, total, data } satisfies ChunkFrame));
    ring.write(chunkBytes);
    if (ring.claimWakeup()) wake();
  }
  return true;
}

/**
 * Serializes `frame` and writes it into `ring`, waking the consumer when
 * needed. Valid JSON frames larger than `ring.capacity - 4` are automatically
 * streamed via ChunkFrame records when the ring can hold chunk envelopes.
 * Unserializable replies (BigInt, circular refs) or frames on tiny rings fall
 * back to a byte-clamped `{ kind: "reply", seq, ok: false, error }` frame so
 * RPC callers never hang.
 */
export function writeWorkerFrame(
  ring: Ring,
  frame: Frame,
  wake: () => void,
  encoder: TextEncoder = new TextEncoder(),
): void {
  try {
    const bytes = encoder.encode(JSON.stringify(frame));
    if (bytes.length <= ring.capacity - 4) {
      ring.write(bytes);
      if (ring.claimWakeup()) wake();
      return;
    }
    if (writeChunked(ring, bytes, wake, encoder)) {
      return;
    }
    throw new RangeError(`frame of ${bytes.length} bytes exceeds ring capacity ${ring.capacity}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (frame.kind !== "reply") {
      console.error(`sweetview worker: ${frame.kind === "event" ? `event ${frame.name}` : "frame"} could not be sent:`, reason);
      return;
    }
    const maxBytes = Math.max(0, ring.capacity - 4);
    const encoded = encodeClampedErrorReply(frame.seq, `sweetview worker: reply could not be sent: ${reason}`, maxBytes, encoder);
    if (!encoded) {
      console.error(`sweetview worker: ring capacity (${ring.capacity} bytes) is too small to send an error reply for seq ${frame.seq}`);
      return;
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
