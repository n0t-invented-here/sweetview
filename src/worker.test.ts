import { describe, expect, test } from "bun:test";
import type { Frame } from "./ipc";
import { Ring } from "./ring";
import { writeWorkerFrame } from "./worker";

function drainFrames(ring: Ring): Frame[] {
  const decoder = new TextDecoder();
  ring.acknowledgeWakeup();
  return [...ring.drain()].map((bytes) => JSON.parse(decoder.decode(bytes)) as Frame);
}

describe("writeWorkerFrame", () => {
  test("writes valid reply and event frames and wakes the consumer", () => {
    const ring = new Ring(Ring.create(256));
    let wakes = 0;
    writeWorkerFrame(ring, { kind: "reply", seq: "1", ok: true, result: { ok: 1 } }, () => wakes++);
    expect(wakes).toBe(1);
    expect(drainFrames(ring)).toEqual([{ kind: "reply", seq: "1", ok: true, result: { ok: 1 } }]);
  });

  test("turns oversized reply frames into an error reply instead of throwing or hanging", () => {
    const ring = new Ring(Ring.create(256));
    let wakes = 0;
    writeWorkerFrame(ring, { kind: "reply", seq: "42", ok: true, result: "x".repeat(500) }, () => wakes++);
    // Subsequent healthy calls still succeed on the same ring
    writeWorkerFrame(ring, { kind: "reply", seq: "43", ok: true, result: "small" }, () => wakes++);
    expect(wakes).toBe(1);
    const frames = drainFrames(ring);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: "reply", seq: "42", ok: false });
    if (frames[0]?.kind === "reply" && !frames[0].ok) {
      expect(frames[0].error).toContain("exceeds ring capacity");
    }
    expect(frames[1]).toEqual({ kind: "reply", seq: "43", ok: true, result: "small" });
  });

  test("turns unserializable replies (BigInt and circular) into error replies", () => {
    const ring = new Ring(Ring.create(512));
    let wakes = 0;
    writeWorkerFrame(ring, { kind: "reply", seq: "b1", ok: true, result: 123n }, () => wakes++);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    writeWorkerFrame(ring, { kind: "reply", seq: "c1", ok: true, result: circular }, () => wakes++);
    expect(wakes).toBe(1);
    const frames = drainFrames(ring);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: "reply", seq: "b1", ok: false });
    expect(frames[1]).toMatchObject({ kind: "reply", seq: "c1", ok: false });
  });

  test("clamps error message when even the error reason is larger than the ring", () => {
    const ring = new Ring(Ring.create(128));
    let wakes = 0;
    writeWorkerFrame(ring, { kind: "reply", seq: "9", ok: false, error: "e".repeat(400) }, () => wakes++);
    expect(wakes).toBe(1);
    const frames = drainFrames(ring);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "reply", seq: "9", ok: false });
  });

  test("swallows oversized or unserializable event frames without crashing", () => {
    const ring = new Ring(Ring.create(128));
    let wakes = 0;
    expect(() => writeWorkerFrame(ring, { kind: "event", name: "big", payload: "z".repeat(400) }, () => wakes++)).not.toThrow();
    expect(() => writeWorkerFrame(ring, { kind: "event", name: "bigint", payload: 99n }, () => wakes++)).not.toThrow();
    expect(wakes).toBe(0);
    expect(drainFrames(ring)).toEqual([]);
  });
});
