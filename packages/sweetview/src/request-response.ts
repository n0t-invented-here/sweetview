import type { NativeRequest, NativeResponse } from "./messages";
import type { Ring } from "./ring";

export type NativeRequestResponse = {
  id: string;
  status: number;
  headers: [string, string][];
  body: Uint8Array;
};

const PREFIX_BYTES = 6;
const encoder = new TextEncoder();
const empty = new Uint8Array();

const enum ResponseFrameKind {
  Complete = 1,
  Part,
  Begin,
  Chunk,
  End,
  Abort,
}

type ResponseMeta = Omit<NativeRequestResponse, "body">;
export type StreamingResponseFrame =
  | ({ kind: "begin" } & ResponseMeta)
  | { kind: "chunk"; id: string; body: Uint8Array }
  | { kind: "end" | "abort"; id: string };

function responseFrameWriter(ring: Ring, wake: () => void) {
  return (kind: ResponseFrameKind, meta: Uint8Array, chunk: Uint8Array = empty) => {
    const frame = new Uint8Array(PREFIX_BYTES + meta.length + chunk.length);
    frame[1] = kind;
    new DataView(frame.buffer).setUint32(2, meta.length, true);
    frame.set(meta, PREFIX_BYTES);
    frame.set(chunk, PREFIX_BYTES + meta.length);
    ring.write(frame);
    if (ring.claimWakeup()) wake();
  };
}

export function runNativeRequest(
  handler: (request: NativeRequest) => NativeResponse,
  request: NativeRequest,
): NativeRequestResponse {
  let response: NativeResponse;
  try {
    response = handler(request);
    if (response && typeof (response as { then?: unknown }).then === "function") {
      void Promise.resolve(response).catch(() => {});
      response = {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: 'Synchronous onRequest returned a Promise. Use onRequest: "worker" with hostService(service, { onRequest }) or hostRequestHandler() for async requests.',
      };
    }
    const status = response.status ?? 200;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError("Invalid response status");
    const headers = Array.isArray(response.headers) ? response.headers : Object.entries(response.headers ?? {});
    const body = typeof response.body === "string"
      ? encoder.encode(response.body)
      : response.body instanceof Uint8Array ? response.body : new Uint8Array(response.body ?? 0);
    return { id: String(request.id), status, headers, body };
  } catch {
    return requestError(request.id, 500, "Internal Server Error");
  }
}

export function requestError(id: bigint, status: number, message: string): NativeRequestResponse {
  return {
    id: String(id),
    status,
    headers: [["Content-Type", "text/plain"]],
    body: encoder.encode(message),
  };
}

/** The worker writes complete responses into the ring, one frame or chunk at a time. */
export function writeRequestResponse(ring: Ring, response: NativeRequestResponse, wake: () => void): void {
  const { id, status, headers, body } = response;
  const maxBytes = ring.capacity - 4 - PREFIX_BYTES;
  const write = responseFrameWriter(ring, wake);

  const meta = encoder.encode(JSON.stringify({ id, status, headers }));
  if (meta.length + body.length <= maxBytes) {
    write(ResponseFrameKind.Complete, meta, body);
    return;
  }

  // Reserve enough room for any sequence number in this body. The first
  // frame carries the complete header table, followed by binary body frames.
  const probe = encoder.encode(JSON.stringify({ id, seq: body.length, total: body.length + 1 }));
  const chunkBytes = maxBytes - probe.length;
  if (chunkBytes < 1) throw new RangeError("Response frame metadata exceeds the ring capacity");
  const total = 1 + Math.ceil(body.length / chunkBytes);
  const first = encoder.encode(JSON.stringify({ id, seq: 0, total, status, headers }));
  if (first.length > maxBytes) throw new RangeError("Response headers exceed the ring capacity");
  write(ResponseFrameKind.Part, first);
  for (let seq = 1, offset = 0; seq < total; seq++, offset += chunkBytes) {
    const part = encoder.encode(JSON.stringify({ id, seq, total }));
    write(ResponseFrameKind.Part, part, body.subarray(offset, offset + chunkBytes));
  }
}

/** Owns the reader until EOF or failure. A failure after begin must terminate that stream. */
export async function writeStreamingResponse(
  ring: Ring,
  head: ResponseMeta,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wake: () => void,
): Promise<void> {
  const write = responseFrameWriter(ring, wake);
  const maxBytes = ring.capacity - 4 - PREFIX_BYTES;
  const meta = encoder.encode(JSON.stringify(head));
  const idMeta = encoder.encode(JSON.stringify({ id: head.id }));
  const chunkBytes = maxBytes - idMeta.length;
  let started = false;
  try {
    if (meta.length > maxBytes || chunkBytes < 1) throw new RangeError("Response headers exceed the ring capacity");
    write(ResponseFrameKind.Begin, meta);
    started = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("Response stream must yield Uint8Array chunks");
      for (let offset = 0; offset < value.byteLength; offset += chunkBytes) {
        write(ResponseFrameKind.Chunk, idMeta, value.subarray(offset, offset + chunkBytes));
      }
    }
    write(ResponseFrameKind.End, idMeta);
  } catch (err) {
    void reader.cancel(err).catch(() => {});
    if (!started) throw err;
    write(ResponseFrameKind.Abort, idMeta);
  } finally {
    reader.releaseLock();
  }
}

type BufferedResponse = { meta: ResponseMeta; chunks: Uint8Array[] };
type PendingResponse = BufferedResponse & { total: number };

function joinResponse({ meta, chunks }: BufferedResponse): NativeRequestResponse {
  const body = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ...meta, body };
}

export class RequestResponseAssembler {
  readonly #pending = new Map<string, PendingResponse>();
  readonly #streams = new Map<string, BufferedResponse>();
  readonly #decoder = new TextDecoder();

  constructor(private readonly bufferStreams = false) {}

  push(bytes: Uint8Array): NativeRequestResponse | StreamingResponseFrame | undefined {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
    const meta = JSON.parse(this.#decoder.decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + size))) as
      ResponseMeta & { seq: number; total: number };
    const { id, status, headers, seq, total } = meta;
    const chunk = bytes.subarray(PREFIX_BYTES + size);
    const kind = bytes[1];
    if (kind === ResponseFrameKind.Complete) return { id, status, headers, body: chunk };
    if (kind !== ResponseFrameKind.Part) {
      let frame: StreamingResponseFrame;
      switch (kind) {
        case ResponseFrameKind.Begin: frame = { kind: "begin", id, status, headers }; break;
        case ResponseFrameKind.Chunk: frame = { kind: "chunk", id, body: chunk }; break;
        case ResponseFrameKind.End: frame = { kind: "end", id }; break;
        case ResponseFrameKind.Abort: frame = { kind: "abort", id }; break;
        default: return;
      }
      return this.bufferStreams ? this.#bufferStream(frame) : frame;
    }

    if (seq === 0) this.#pending.set(id, { meta: { id, status, headers }, total, chunks: [] });
    const pending = this.#pending.get(id);
    if (!pending || pending.total !== total || pending.chunks.length !== seq) {
      this.#pending.delete(id);
      return;
    }
    pending.chunks.push(chunk);
    if (pending.chunks.length !== total) return;

    this.#pending.delete(id);
    return joinResponse(pending);
  }

  #bufferStream(frame: StreamingResponseFrame): NativeRequestResponse | undefined {
    const { id } = frame;
    if (frame.kind === "begin") {
      this.#streams.set(id, { meta: { id, status: frame.status, headers: frame.headers }, chunks: [] });
      return;
    }
    const pending = this.#streams.get(id);
    if (!pending) return;
    if (frame.kind === "chunk") {
      pending.chunks.push(frame.body);
      return;
    }
    this.#streams.delete(id);
    return frame.kind === "abort"
      ? requestError(BigInt(id), 500, "Internal Server Error")
      : joinResponse(pending);
  }

  clear(): void {
    this.#pending.clear();
    this.#streams.clear();
  }
}
