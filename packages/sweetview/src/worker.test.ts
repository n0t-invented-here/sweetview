import { describe, expect, test } from "bun:test";
import { createFrameAssembler, type Frame, type WireFrame } from "@n1h/sweetview-ipc";
import { Ring } from "./ring";
import { writeWorkerFrame } from "./worker";

function drainFrames(ring: Ring, assembler = createFrameAssembler()): Frame[] {
  const decoder = new TextDecoder();
  ring.acknowledgeWakeup();
  const out: Frame[] = [];
  for (const bytes of ring.drain()) {
    const wire = JSON.parse(decoder.decode(bytes)) as WireFrame;
    const frame = assembler.push(wire);
    if (frame) out.push(frame);
  }
  return out;
}

describe("writeWorkerFrame", () => {
  test("writes valid reply and event frames and wakes the consumer", () => {
    const ring = new Ring(Ring.create(256));
    let wakes = 0;
    writeWorkerFrame(ring, { kind: "reply", seq: "1", ok: true, result: { ok: 1 } }, () => wakes++);
    expect(wakes).toBe(1);
    expect(drainFrames(ring)).toEqual([{ kind: "reply", seq: "1", ok: true, result: { ok: 1 } }]);
  });

  test("chunks oversized valid JSON reply frames across the ring and reassembles them intact", () => {
    const ring = new Ring(Ring.create(512));
    const assembler = createFrameAssembler();
    const collected: Frame[] = [];
    // Drain asynchronously whenever producer wakes (simulating real UI thread draining during multi-chunk bursts)
    const wake = () => collected.push(...drainFrames(ring, assembler));
    const big = "x".repeat(2000);
    writeWorkerFrame(ring, { kind: "reply", seq: "42", ok: true, result: big }, wake);
    writeWorkerFrame(ring, { kind: "reply", seq: "43", ok: true, result: "small" }, wake);
    collected.push(...drainFrames(ring, assembler));
    expect(collected).toEqual([
      { kind: "reply", seq: "42", ok: true, result: big },
      { kind: "reply", seq: "43", ok: true, result: "small" },
    ]);
  });

  test("falls back to a clamped error reply when ring is too small even for chunk envelopes", () => {
    const ring = new Ring(Ring.create(64));
    let wakes = 0;
    writeWorkerFrame(ring, { kind: "reply", seq: "7", ok: true, result: "x".repeat(500) }, () => wakes++);
    expect(wakes).toBe(1);
    const frames = drainFrames(ring);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "reply", seq: "7", ok: false });
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

  test("clamps error message when even the error reason is larger than a tiny ring", () => {
    const ring = new Ring(Ring.create(64));
    let wakes = 0;
    writeWorkerFrame(ring, { kind: "reply", seq: "9", ok: false, error: "e".repeat(400) }, () => wakes++);
    expect(wakes).toBe(1);
    const frames = drainFrames(ring);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "reply", seq: "9", ok: false });
  });

  test("clamps error messages containing quotes, NUL bytes, and multibyte UTF-8 accurately by byte length", () => {
    const ring = new Ring(Ring.create(64));
    let wakes = 0;
    const nasty = '"\\"\0'.repeat(60) + "🥐".repeat(40);
    writeWorkerFrame(ring, { kind: "reply", seq: "n1", ok: false, error: nasty }, () => wakes++);
    expect(wakes).toBe(1);
    const frames = drainFrames(ring);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "reply", seq: "n1", ok: false });
  });

  test("swallows unserializable event frames without crashing and chunks oversized valid events", () => {
    const ring = new Ring(Ring.create(512));
    const assembler = createFrameAssembler();
    const collected: Frame[] = [];
    const wake = () => collected.push(...drainFrames(ring, assembler));

    expect(() => writeWorkerFrame(ring, { kind: "event", name: "bigint", payload: 99n }, wake)).not.toThrow();
    expect(collected).toEqual([]);

    const largePayload = { text: "z".repeat(1200) };
    writeWorkerFrame(ring, { kind: "event", name: "big", payload: largePayload }, wake);
    collected.push(...drainFrames(ring, assembler));
    expect(collected).toEqual([{ kind: "event", name: "big", payload: largePayload }]);
  });
});
