import type { NativeRequest, NativeResponse } from "./messages";
import type { Ring } from "./ring";

export type HttpResponse = {
  id: string;
  status: number;
  headers: [string, string][];
  body: Uint8Array;
};

const PREFIX_BYTES = 6;
const encoder = new TextEncoder();

export function runNativeRequest(
  handler: (request: NativeRequest) => NativeResponse,
  request: NativeRequest,
): HttpResponse {
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

export function requestError(id: bigint, status: number, message: string): HttpResponse {
  return {
    id: String(id),
    status,
    headers: [["Content-Type", "text/plain"]],
    body: encoder.encode(message),
  };
}

/** The worker writes complete responses into the ring, one frame or chunk at a time. */
export function writeHttpResponse(ring: Ring, response: HttpResponse, wake: () => void): void {
  const { id, status, headers, body } = response;
  const maxBytes = ring.capacity - 4 - PREFIX_BYTES;
  function write(kind: number, meta: Uint8Array, chunk: Uint8Array) {
    const frame = new Uint8Array(PREFIX_BYTES + meta.length + chunk.length);
    frame[1] = kind;
    new DataView(frame.buffer).setUint32(2, meta.length, true);
    frame.set(meta, PREFIX_BYTES);
    frame.set(chunk, PREFIX_BYTES + meta.length);
    ring.write(frame);
    if (ring.claimWakeup()) wake();
  }

  const meta = encoder.encode(JSON.stringify({ id, status, headers }));
  if (meta.length + body.length <= maxBytes) {
    write(1, meta, body);
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
  write(2, first, body.subarray(0, 0));
  for (let seq = 1, offset = 0; seq < total; seq++, offset += chunkBytes) {
    const part = encoder.encode(JSON.stringify({ id, seq, total }));
    write(2, part, body.subarray(offset, offset + chunkBytes));
  }
}

type ResponseMeta = Omit<HttpResponse, "body">;
type PendingResponse = { meta: ResponseMeta; total: number; chunks: Uint8Array[]; length: number };

export class HttpResponseAssembler {
  readonly #pending = new Map<string, PendingResponse>();
  readonly #decoder = new TextDecoder();

  push(bytes: Uint8Array): HttpResponse | undefined {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
    const meta = JSON.parse(this.#decoder.decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + size))) as
      ResponseMeta & { seq: number; total: number };
    const { id, status, headers, seq, total } = meta;
    const chunk = bytes.subarray(PREFIX_BYTES + size);
    if (bytes[1] === 1) return { id, status, headers, body: chunk };

    if (seq === 0) this.#pending.set(id, { meta: { id, status, headers }, total, chunks: [], length: 0 });
    const pending = this.#pending.get(id);
    if (!pending || pending.total !== total || pending.chunks.length !== seq) {
      this.#pending.delete(id);
      return;
    }
    pending.chunks.push(chunk);
    pending.length += chunk.length;
    if (pending.chunks.length !== total) return;

    this.#pending.delete(id);
    const body = new Uint8Array(pending.length);
    let offset = 0;
    for (const part of pending.chunks) {
      body.set(part, offset);
      offset += part.length;
    }
    return { ...pending.meta, body };
  }

  clear(): void {
    this.#pending.clear();
  }
}
