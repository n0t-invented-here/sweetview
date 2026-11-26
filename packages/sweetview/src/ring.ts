// Single-producer / single-consumer byte ring over a SharedArrayBuffer.
//
// Producer: the worker (Bun event loop). Consumer: the UI thread, inside a
// webview_dispatch callback. Frames are length-prefixed. The producer blocks
// (Atomics.wait) only when the ring is full; the consumer never blocks.
//
// Header (Int32, shared): [0] write cursor, [1] read cursor, [2] wakeup pending.
// Cursors grow monotonically and wrap in int32; all arithmetic is done with
// `| 0` so the wrap is harmless.

const HEADER_BYTES = 16;
const WRITE = 0;
const READ = 1;
const PENDING = 2;

export class Ring {
  readonly #hdr: Int32Array;
  readonly #data: Uint8Array;
  readonly #cap: number;

  /** `capacity` must be a power of two: the cursors wrap in int32 and `pos % capacity` only stays continuous across that wrap when capacity divides 2^32. */
  static create(capacity: number): SharedArrayBuffer {
    Ring.#checkCapacity(capacity);
    return new SharedArrayBuffer(HEADER_BYTES + capacity);
  }

  constructor(sab: SharedArrayBuffer) {
    this.#hdr = new Int32Array(sab, 0, HEADER_BYTES / 4);
    this.#data = new Uint8Array(sab, HEADER_BYTES);
    this.#cap = this.#data.length;
    Ring.#checkCapacity(this.#cap);
  }

  static #checkCapacity(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 16 || (capacity & (capacity - 1)) !== 0 || capacity > 1 << 30) {
      throw new RangeError(`ring capacity must be a power of two between 16 and 2^30, got ${capacity}`);
    }
  }

  get capacity() {
    return this.#cap;
  }

  /** Producer side. Blocks while the ring is full. */
  write(bytes: Uint8Array): void {
    const need = 4 + bytes.length;
    if (need > this.#cap) throw new RangeError(`frame of ${bytes.length} bytes exceeds ring capacity ${this.#cap}`);
    for (;;) {
      const w = Atomics.load(this.#hdr, WRITE);
      const r = Atomics.load(this.#hdr, READ);
      if (((w - r) | 0) + need <= this.#cap) break;
      Atomics.wait(this.#hdr, READ, r);
    }
    const w = Atomics.load(this.#hdr, WRITE);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length, true);
    this.#put(w, len);
    this.#put((w + 4) | 0, bytes);
    Atomics.store(this.#hdr, WRITE, (w + need) | 0);
  }

  /**
   * Producer side. Returns true when the caller should wake the consumer
   * (no wakeup is already in flight), so a burst costs one dispatch.
   */
  claimWakeup(): boolean {
    return Atomics.compareExchange(this.#hdr, PENDING, 0, 1) === 0;
  }

  /** Consumer side. Call first thing in the wakeup, before draining. */
  acknowledgeWakeup(): void {
    Atomics.store(this.#hdr, PENDING, 0);
  }

  /** Consumer side. Yields every complete frame currently in the ring. */
  *drain(): Generator<Uint8Array> {
    let r = Atomics.load(this.#hdr, READ);
    const w = Atomics.load(this.#hdr, WRITE);
    while (r !== w) {
      const lenBytes = this.#get(r, 4);
      const len = new DataView(lenBytes.buffer, lenBytes.byteOffset).getUint32(0, true);
      const frame = this.#get((r + 4) | 0, len);
      r = (r + 4 + len) | 0;
      Atomics.store(this.#hdr, READ, r);
      Atomics.notify(this.#hdr, READ);
      yield frame;
    }
  }

  #offset(pos: number) {
    const m = pos % this.#cap;
    return m < 0 ? m + this.#cap : m;
  }

  #put(pos: number, bytes: Uint8Array) {
    const off = this.#offset(pos);
    const first = Math.min(bytes.length, this.#cap - off);
    this.#data.set(bytes.subarray(0, first), off);
    if (first < bytes.length) this.#data.set(bytes.subarray(first), 0);
  }

  #get(pos: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    const off = this.#offset(pos);
    const first = Math.min(len, this.#cap - off);
    out.set(this.#data.subarray(off, off + first), 0);
    if (first < len) out.set(this.#data.subarray(0, len - first), first);
    return out;
  }
}
