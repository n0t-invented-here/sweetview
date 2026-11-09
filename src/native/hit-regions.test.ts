import { describe, expect, test } from "bun:test";
import { convexHull, hitRegions, packRegions } from "./hit-regions";

const rect = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe("packRegions", () => {
  test("packs count, bounds, then the points", () => {
    const packed = packRegions([rect(1.4, 2.6, 3.2, 1.1)]);
    expect(Array.from(packed)).toEqual([4, 1, 2, 5, 4, 1, 3, 5, 3, 5, 4, 1, 4]);
  });
  test("drops polygons with fewer than three points", () => {
    expect(packRegions([[{ x: 0, y: 0 }, { x: 5, y: 5 }]]).length).toBe(0);
  });
});

describe("hitRegions", () => {
  const packed = packRegions([rect(10, 10, 10, 10), rect(50, 0, 5, 5)]);
  test("inside any polygon", () => {
    expect(hitRegions(packed, 11, 11)).toBe(true);
    expect(hitRegions(packed, 19, 19)).toBe(true);
    expect(hitRegions(packed, 52, 2)).toBe(true);
  });
  test("outside is outside", () => {
    expect(hitRegions(packed, 25, 15)).toBe(false);
    expect(hitRegions(packed, 15, 25)).toBe(false);
    expect(hitRegions(packed, 0, 0)).toBe(false);
    expect(hitRegions(new Int32Array(0), 0, 0)).toBe(false);
  });
  test("a diamond: inside its bounds but outside the shape misses", () => {
    const diamond = packRegions([[{ x: 10, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 10 }]]);
    expect(hitRegions(diamond, 10, 10)).toBe(true);
    expect(hitRegions(diamond, 1, 1)).toBe(false); // the corner of the bounding box
    expect(hitRegions(diamond, 19, 19)).toBe(false);
  });
});

describe("convexHull", () => {
  test("the hull of a box's corners plus interior points is the box", () => {
    const hull = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 2, y: 2 }, { x: 1, y: 3 }]);
    expect(hull).toHaveLength(4);
    expect(hull).toEqual(expect.arrayContaining([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]));
  });
  test("collinear and duplicate points are dropped", () => {
    expect(convexHull([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 2 }])).toHaveLength(2);
  });
});
