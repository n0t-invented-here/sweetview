// Hit regions: the polygons of a window that take clicks, packed flat so a
// cursor poll tests them without allocating. Platform-free; both overlays use
// it on every timer tick. A rectangle is a four-point polygon; a mesh's
// silhouette is the convex hull of its projected bounding-box corners.

import type { HitRefiner, Overlay, Point } from "./overlay";

/** One region: a simple polygon in window-local units, any winding. */
export type HitPolygon = Point[];

/**
 * Polygons as one flat number array, the shape to send from the page in an
 * IPC method (JSON of a flat array is a fraction of an array of point
 * objects): per polygon a point count, then that many x, y pairs.
 */
export function flattenRegions(polygons: HitPolygon[]): number[] {
  const flat: number[] = [];
  for (const poly of polygons) {
    flat.push(poly.length);
    for (const p of poly) flat.push(p.x, p.y);
  }
  return flat;
}

/** The inverse of `flattenRegions`, for the UI-thread method that receives them. */
export function unpackRegions(flat: readonly number[]): HitPolygon[] {
  const polygons: HitPolygon[] = [];
  for (let i = 0; i < flat.length; ) {
    const count = flat[i++]!;
    const polygon: HitPolygon = [];
    for (let k = 0; k < count; k++) polygon.push({ x: flat[i++]!, y: flat[i++]! });
    polygons.push(polygon);
  }
  return polygons;
}

/** A question for the page: is its drawing solid at this window-local point? `id` comes back in the answer. */
export type HitProbe = Point & { id: number };

/**
 * The UI-thread side of exact click-through: the page sends its polygons
 * (coarse), the overlay asks for the exact answer inside one through
 * `probe` (an event to the page), and the page's reply comes back through
 * `answer`. See `Overlay.setHitRegions`. A reply to anything but the latest
 * probe is dropped; a page that never replies leaves polygon precision.
 */
export type HitRelay = {
  /** The page's latest polygons (window-local units). Applied at once when enabled. */
  setRegions(polygons: HitPolygon[]): void;
  /** The page's reply to the probe with that id. */
  answer(reply: { id: number; solid: boolean }): void;
  /** Off: the whole window takes clicks, whatever the regions say (a "click through" toggle). Default on. */
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** Re-sends the current state to the overlay; after creating the webview, say. */
  apply(): void;
};

export function createHitRelay(overlay: Pick<Overlay, "setHitRegions">, probe: (question: HitProbe) => void): HitRelay {
  let regions: HitPolygon[] = [];
  let on = true;
  let seq = 0;
  let pending: { id: number; answer: (solid: boolean) => void } | undefined;
  const refine: HitRefiner = (local, reply) => {
    const id = ++seq;
    pending = { id, answer: reply };
    probe({ id, x: local.x, y: local.y });
  };
  const apply = () => overlay.setHitRegions(on ? regions : null, refine);
  return {
    setRegions(polygons) {
      regions = polygons;
      apply();
    },
    answer({ id, solid }) {
      if (pending?.id === id) pending.answer(solid);
    },
    setEnabled(next) {
      on = next;
      apply();
    },
    enabled: () => on,
    apply,
  };
}

/**
 * Per polygon: [count, minX, minY, maxX, maxY, x0, y0, x1, y1, ...]. The
 * bounds come first so most polygons are rejected with four comparisons.
 * Polygons with fewer than three points are dropped.
 */
export function packRegions(polygons: HitPolygon[]): Int32Array {
  const kept = polygons.filter((p) => p.length >= 3);
  const packed = new Int32Array(kept.reduce((n, p) => n + 5 + p.length * 2, 0));
  let o = 0;
  for (const poly of kept) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    packed[o++] = poly.length;
    packed[o++] = Math.floor(minX);
    packed[o++] = Math.floor(minY);
    packed[o++] = Math.ceil(maxX);
    packed[o++] = Math.ceil(maxY);
    for (const p of poly) {
      packed[o++] = Math.round(p.x);
      packed[o++] = Math.round(p.y);
    }
  }
  return packed;
}

/** Is the point inside any packed polygon? Bounds first, then even-odd ray casting. Hundreds of polygons cost microseconds. */
export function hitRegions(packed: Int32Array, x: number, y: number): boolean {
  let o = 0;
  while (o < packed.length) {
    const count = packed[o]!;
    const inBounds = x >= packed[o + 1]! && x <= packed[o + 3]! && y >= packed[o + 2]! && y <= packed[o + 4]!;
    const first = o + 5;
    if (inBounds) {
      let inside = false;
      for (let i = 0, j = count - 1; i < count; j = i++) {
        const xi = packed[first + i * 2]!;
        const yi = packed[first + i * 2 + 1]!;
        const xj = packed[first + j * 2]!;
        const yj = packed[first + j * 2 + 1]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    o = first + count * 2;
  }
  return false;
}

/** The convex hull of some points (Andrew's monotone chain), counter-clockwise, no duplicates. Fewer than three distinct points give fewer than three back. */
export function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y).filter((p, i, all) => i === 0 || p.x !== all[i - 1]!.x || p.y !== all[i - 1]!.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
