import { describe, expect, test } from "bun:test";
import { Ring } from "./ring";

const enc = new TextEncoder();
const dec = new TextDecoder();
const drainAll = (ring: Ring) => [...ring.drain()].map((b) => dec.decode(b));

describe("Ring", () => {
  test("frames come out in order and the ring is then empty", () => {
    const ring = new Ring(Ring.create(64));
    ring.write(enc.encode("one"));
    ring.write(enc.encode("two"));
    expect(drainAll(ring)).toEqual(["one", "two"]);
    expect(drainAll(ring)).toEqual([]);
  });

  test("frames wrap around the end of the buffer", () => {
    const ring = new Ring(Ring.create(32));
    for (let i = 0; i < 20; i++) {
      const text = `frame-${i}-padding`; // 4 + 16 bytes: forces a split at some point
      ring.write(enc.encode(text));
      expect(drainAll(ring)).toEqual([text]);
    }
  });

  test("a frame larger than the ring is refused", () => {
    const ring = new Ring(Ring.create(16));
    expect(() => ring.write(new Uint8Array(13))).toThrow(RangeError);
    ring.write(new Uint8Array(12)); // exactly fits with its 4-byte length
    expect(drainAll(ring).length).toBe(1);
  });

  test("capacity must be a power of two", () => {
    expect(() => Ring.create(1_000_000)).toThrow(RangeError);
    expect(() => Ring.create(8)).toThrow(RangeError);
    expect(() => new Ring(new SharedArrayBuffer(16 + 24))).toThrow(RangeError);
    expect(Ring.create(1 << 20).byteLength).toBe(16 + (1 << 20));
  });

  test("one wakeup per burst", () => {
    const ring = new Ring(Ring.create(64));
    expect(ring.claimWakeup()).toBe(true);
    expect(ring.claimWakeup()).toBe(false);
    ring.acknowledgeWakeup();
    expect(ring.claimWakeup()).toBe(true);
  });

  test("the producer blocks on a full ring until the consumer drains", async () => {
    const sab = Ring.create(16);
    const producer = new Ring(sab);
    const consumer = new Ring(sab);
    producer.write(new Uint8Array(8)); // 12 of 16 used; the next 8-byte frame does not fit
    const worker = new Worker(new URL("./ring.test.worker.ts", import.meta.url).href);
    const done = new Promise<string>((resolve) => (worker.onmessage = (e) => resolve(e.data as string)));
    worker.postMessage(sab);
    await Bun.sleep(30);
    expect(drainAll(consumer).length).toBe(1); // frees the space; Atomics.notify wakes the worker
    expect(await done).toBe("written");
    expect(drainAll(consumer).length).toBe(1);
    worker.terminate();
  });
});
