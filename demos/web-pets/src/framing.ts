// The camera, as numbers, and what a model's box looks like through it:
// where its feet, its head and its sides land on the square canvas. The
// scene aims its camera from these; the life uses the fractions for bumping
// into other pets and standing on their heads.

import type { Direction } from "./model";

/** A level look from the pet's own height. */
export const CAMERA_DISTANCE = 4.4;
export const CAMERA_FOV = 0.5;
/** How far the models reach toward the camera; the front of that footprint sits on the canvas's bottom edge. */
export const FOOTPRINT_Z = 0.8;
// A fitted model faces +z, away from the camera at -z, and its face is on
// the front, so a pure side view hides it. Facing right is a quarter turn
// plus a bit toward the viewer; facing left is the mirror on the far side of
// pi (facing the camera), so a turn swings the face past the viewer, never
// the back. (Rotation about y by θ takes +z to (sin θ, 0, cos θ) and +x to
// (cos θ, 0, -sin θ); checked against Babylon, not derived.)
const TOWARD = 0.5;
export const yawFor = (dir: Direction) => (dir === 1 ? Math.PI / 2 + TOWARD : (3 * Math.PI) / 2 - TOWARD);

export type Bounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/** Where a model-space point lands on the canvas, as fractions of its edge (0,0 top-left), at any scale. Ignores the two-pixel ground margin. */
export function projectToCanvas(p: { x: number; y: number; z: number }): { x: number; y: number } {
  const t = Math.tan(CAMERA_FOV / 2);
  const cameraHeight = (CAMERA_DISTANCE - FOOTPRINT_Z) * t;
  const depth = p.z + CAMERA_DISTANCE;
  const nx = p.x / (depth * t);
  const ny = (p.y - cameraHeight) / (depth * t);
  return { x: (1 + nx) / 2, y: (1 - ny) / 2 };
}

export type Proportions = {
  /** How much of the canvas's width the model spans, as seen facing along the ground: its lower three quarters, so a raised tail or a hat does not count. */
  body: number;
  /** How far down the canvas the top of the model's head is: the surface straight above the model's middle, so a pet standing on it stands on the head, not on a tail tip. */
  head: number;
  /** How far down the canvas the model's feet are, at its centre: above the bottom edge, which the front of the footprint touches. */
  feet: number;
};

/** Where the ground at a model's centre lands on the canvas: the feet of a fitted model. */
export const FEET = projectToCanvas({ x: 0, y: 0, z: 0 }).y;

/** The lower share of the model's height that counts as its body, side to side. */
const BAND = 0.75;

/**
 * The highest surface of the model straight above the point (x, z): the
 * top of whatever is there, found through the triangles, so a box with
 * only corner vertices still has a top in its middle. Nothing there: undefined.
 */
export function topAt(points: ArrayLike<number>, triangles: ArrayLike<number>, x: number, z: number): number | undefined {
  let top: number | undefined;
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = triangles[i]! * 3;
    const b = triangles[i + 1]! * 3;
    const c = triangles[i + 2]! * 3;
    const ax = points[a]! - x;
    const az = points[a + 2]! - z;
    const bx = points[b]! - x;
    const bz = points[b + 2]! - z;
    const cx = points[c]! - x;
    const cz = points[c + 2]! - z;
    // Barycentric test in the ground plane.
    const d = (bz - cz) * ax + (cx - bx) * az + bx * cz - cx * bz;
    if (Math.abs(d) < 1e-12) continue;
    const u = ((bz - cz) * 0 + (cx - bx) * 0 + bx * cz - cx * bz) / d;
    const v = ((cz - az) * 0 + (ax - cx) * 0 + cx * az - ax * cz) / d;
    const w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
    const y = u * points[a + 1]! + v * points[b + 1]! + w * points[c + 1]!;
    if (top === undefined || y > top) top = y;
  }
  return top;
}

/**
 * A fitted model's points (x, y, z triples, centred on its box with its
 * feet at y = 0) and triangles (point indices), turned to `yaw` about y and
 * seen through the camera.
 */
export function proportionsOf(points: ArrayLike<number>, triangles: ArrayLike<number>, yaw: number): Proportions {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    minX = Math.min(minX, points[i]!);
    maxX = Math.max(maxX, points[i]!);
    minY = Math.min(minY, points[i + 1]!);
    maxY = Math.max(maxY, points[i + 1]!);
    minZ = Math.min(minZ, points[i + 2]!);
    maxZ = Math.max(maxZ, points[i + 2]!);
  }
  if (minX === Infinity) return { body: 0, head: 0, feet: FEET };
  // The head: the top above the middle, or above the nearest of a few spots around it; the model's top when none has anything.
  const spots = [
    [0, 0],
    [(maxX - minX) * 0.1, 0],
    [-(maxX - minX) * 0.1, 0],
    [0, (maxZ - minZ) * 0.1],
    [0, -(maxZ - minZ) * 0.1],
  ];
  let headTop = -Infinity;
  for (const [sx, sz] of spots) {
    const t = topAt(points, triangles, sx!, sz!);
    if (t !== undefined) headTop = Math.max(headTop, t);
  }
  if (headTop === -Infinity) headTop = maxY;
  const bandTop = minY + (maxY - minY) * BAND;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let left = Infinity;
  let right = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const z = points[i + 2]!;
    if (y <= bandTop) {
      const px = projectToCanvas({ x: x * c + z * s, y, z: -x * s + z * c }).x;
      left = Math.min(left, px);
      right = Math.max(right, px);
    }
  }
  const head = projectToCanvas({ x: 0, y: headTop, z: 0 }).y;
  const feet = projectToCanvas({ x: 0, y: minY, z: 0 }).y;
  return { body: Math.min(1, Math.max(0, right - left)), head: Math.max(0, head), feet: Math.min(1, feet) };
}
