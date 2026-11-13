import { describe, expect, test } from "bun:test";
import { FEET, projectToCanvas, proportionsOf, topAt, yawFor } from "./framing";

describe("the camera", () => {
  test("puts the front of the footprint on the bottom edge and the origin in the middle", () => {
    expect(projectToCanvas({ x: 0, y: 0, z: -0.8 }).y).toBeCloseTo(1, 6);
    expect(projectToCanvas({ x: 0, y: 0, z: 0 }).x).toBeCloseTo(0.5, 6);
  });
  /** A box as a mesh: eight corners and twelve triangles. */
  type Mesh = { points: number[]; triangles: number[] };
  const box = (x: number, y0: number, y1: number, z: number, cx = 0, cz = 0): Mesh => {
    const points = [-x, x].flatMap((px) => [y0, y1].flatMap((py) => [-z, z].map((pz) => [px + cx, py, pz + cz]))).flat();
    // corner index = (px ? 4 : 0) + (py ? 2 : 0) + (pz ? 1 : 0)
    const quads = [
      [0, 1, 3, 2], // -x
      [4, 6, 7, 5], // +x
      [0, 4, 5, 1], // -y
      [2, 3, 7, 6], // +y
      [0, 2, 6, 4], // -z
      [1, 5, 7, 3], // +z
    ];
    return { points, triangles: quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]) };
  };
  const merge = (...meshes: Mesh[]): Mesh => {
    const points: number[] = [];
    const triangles: number[] = [];
    for (const m of meshes) {
      const base = points.length / 3;
      points.push(...m.points);
      triangles.push(...m.triangles.map((i) => i + base));
    }
    return { points, triangles };
  };
  const of = (m: Mesh) => proportionsOf(m.points, m.triangles, yawFor(1));
  test("the cat: its body, not its tail, is the head to stand on and the width to bump", () => {
    // A body box 1.26 wide, 1.2 tall, 1.33 deep, with a tail at the back rising to 1.7.
    const body = box(0.63, 0, 1.2, 0.66);
    const cat = merge(body, box(0.05, 1.2, 1.7, 0.05, 0, -0.55));
    const p = of(cat);
    expect(p.head).toBeCloseTo(projectToCanvas({ x: 0, y: 1.2, z: 0 }).y, 6);
    expect(p.body).toBeGreaterThan(0.6);
    expect(p.body).toBeLessThan(0.8);
    expect(p.feet).toBeCloseTo(FEET, 6);
    expect(p.body).toBeCloseTo(of(body).body, 6);
  });
  test("a hat above the body does not widen it; a wider body is wider; a taller one has its head higher", () => {
    const body = box(0.3, 0, 1, 0.2);
    const hat = merge(body, box(0.9, 1.05, 1.1, 0.9));
    expect(of(hat).body).toBeCloseTo(of(body).body, 6);
    expect(of(hat).head).toBeCloseTo(projectToCanvas({ x: 0, y: 1.1, z: 0 }).y, 6); // the hat is over the middle: it counts
    expect(of(box(0.8, 0, 1, 0.8)).body).toBeGreaterThan(of(box(0.4, 0, 1, 0.4)).body);
    expect(of(box(0.5, 0, 1.6, 0.5)).head).toBeLessThan(of(box(0.5, 0, 1, 0.5)).head);
    expect(of(box(3, 0, 3, 3)).body).toBeLessThanOrEqual(1);
    expect(proportionsOf([], [], 0)).toEqual({ body: 0, head: 0, feet: FEET });
    // A thin figure: its head is as deep as its body, and still counts.
    const thin = merge(box(0.2, 0, 1, 0.1), box(0.15, 1, 1.3, 0.1));
    expect(of(thin).head).toBeCloseTo(projectToCanvas({ x: 0, y: 1.3, z: 0 }).y, 6);
  });
  test("topAt finds the surface above a point through the triangles, and nothing beside the model", () => {
    const b = box(0.5, 0, 1, 0.5);
    expect(topAt(b.points, b.triangles, 0, 0)).toBeCloseTo(1, 9);
    expect(topAt(b.points, b.triangles, 0.49, -0.49)).toBeCloseTo(1, 9);
    expect(topAt(b.points, b.triangles, 0.6, 0)).toBeUndefined();
  });
});
