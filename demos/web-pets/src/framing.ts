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
// The models face +z as loaded, away from the camera at -z, and their faces
// are on the front, so a pure side view hides them. Facing right is a
// quarter turn plus a bit toward the viewer; facing left is the mirror on the
// far side of pi (facing the camera), so a turn swings the face past the
// viewer, never the back.
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
  /** How much of the canvas's width the model spans, as seen facing along the ground. */
  body: number;
  /** How far down the canvas the top of the model is. */
  head: number;
};

/** The model's box, turned to `yaw` about y and seen through the camera. */
export function proportionsOf(bounds: Bounds, yaw: number): Proportions {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const p = projectToCanvas({ x: x * c + z * s, y, z: -x * s + z * c });
        left = Math.min(left, p.x);
        right = Math.max(right, p.x);
        top = Math.min(top, p.y);
      }
  return { body: Math.min(1, right - left), head: Math.max(0, top) };
}
