import { describe, expect, test } from "bun:test";
import { projectToCanvas, proportionsOf, yawFor } from "./framing";

describe("the camera", () => {
  test("puts the front of the footprint on the bottom edge and the origin in the middle", () => {
    expect(projectToCanvas({ x: 0, y: 0, z: -0.8 }).y).toBeCloseTo(1, 6);
    expect(projectToCanvas({ x: 0, y: 0, z: 0 }).x).toBeCloseTo(0.5, 6);
  });
  test("the cat's box: about four fifths of the canvas wide with its tail, head a quarter down", () => {
    // The cat as modelled: x -0.63..0.63, y 0..1.40, z -0.63..0.70 (the tail).
    const p = proportionsOf({ min: { x: -0.63, y: 0, z: -0.63 }, max: { x: 0.63, y: 1.4, z: 0.7 } }, yawFor(1));
    expect(p.body).toBeGreaterThan(0.7);
    expect(p.body).toBeLessThan(0.85);
    expect(p.head).toBeGreaterThan(0.22);
    expect(p.head).toBeLessThan(0.3);
  });
  test("a taller model has its head higher; a wider one is wider", () => {
    const box = (h: number, w: number) => proportionsOf({ min: { x: -w, y: 0, z: -w }, max: { x: w, y: h, z: w } }, yawFor(1));
    expect(box(1.6, 0.5).head).toBeLessThan(box(1.0, 0.5).head);
    expect(box(1, 0.8).body).toBeGreaterThan(box(1, 0.4).body);
    expect(box(3, 3).body).toBeLessThanOrEqual(1);
    expect(box(3, 3).head).toBeGreaterThanOrEqual(0);
  });
});
