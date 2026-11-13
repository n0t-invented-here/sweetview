// The picture: a Babylon.js scene on one canvas, with a level camera aimed so
// the model's feet sit on the canvas's bottom edge at every scale, one model
// at a time, fitted (centred, feet at zero, to the spec's height, turned to
// face +z), its clips by name, and a triangle pick for "is the pet under
// this point".

import "@babylonjs/loaders/glTF/2.0";
import "@babylonjs/core/Culling/ray"; // scene.pick
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { CAMERA_DISTANCE, CAMERA_FOV, FOOTPRINT_Z, proportionsOf, yawFor, type Bounds, type Proportions } from "./framing";
import { clipFor, type ClipRef, type Direction, type PetModel } from "./model";

export type PetScene = {
  /** Fit the canvas to a `size` CSS-pixel square showing the model at `scale`, feet on the bottom edge. */
  resize(size: number, scale: number): void;
  /** Load the model at this URL and show it in place of the current one, fitted as the spec says. A later call wins over an earlier one still loading. */
  show(url: string, model: PetModel): Promise<void>;
  /** Is this clip in the loaded file? */
  has(clip: string): boolean;
  /** How long one pass of the clip takes at speed 1. */
  clipSeconds(clip: string): number | undefined;
  /** The loaded model's box through the camera: how wide it is and how far down its head is, as fractions of the canvas. */
  proportions(): Proportions | undefined;
  play(clip: ClipRef, speed: number): void;
  /** Turn toward this side; the turn is eased over the next frames. */
  face(dir: Direction): void;
  /** Draw a frame; `dt` in seconds, for the turn. */
  render(dt: number): void;
  /** Is any of the model's geometry under this point of the canvas (CSS pixels)? Triangle-accurate. */
  solidAt(cssX: number, cssY: number): boolean;
  dispose(): void;
};

const GROUND_MARGIN_PX = 2;
/** The turn that makes a model face +z, where the pets face as modelled: rotation about y by θ takes +x to (cos θ, -sin θ). */
const forwardYaw = (forward: PetModel["forward"]): number => (forward === "-z" ? Math.PI : forward === "+x" ? -Math.PI / 2 : forward === "-x" ? Math.PI / 2 : 0);

/** Throws when WebGL is not available: there is no pet without it. */
export function createPetScene(canvas: HTMLCanvasElement): PetScene {
  const engine = new Engine(canvas, true, { premultipliedAlpha: false, alpha: true }, true);
  const scene = new Scene(engine);
  // A scene attaches its own pointer handling to the canvas (a pick on every
  // move, and the cursor reset to its default each time). The pet does its own
  // picking and sets its own cursor, so that goes.
  scene.detachControl();
  scene.clearColor = new Color4(0, 0, 0, 0);

  const camera = new TargetCamera("camera", new Vector3(0, 0, -CAMERA_DISTANCE), scene);
  camera.fov = CAMERA_FOV;
  camera.minZ = 0.1;
  const key = new DirectionalLight("key", new Vector3(-0.6, -1, 0.8), scene);
  key.intensity = 1.6;
  const fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
  fill.intensity = 0.9;
  fill.groundColor = new Color3(0.45, 0.42, 0.5);

  const root = new TransformNode("pet", scene); // the fitted model hangs here; its feet are at y = 0
  let yaw = yawFor(1);
  let yawTarget = yaw;
  let scale = 1;

  // The model's ground (y = 0 across its footprint) sits on the canvas's bottom
  // edge. With a level camera a ground point at depth z projects to
  // -height / ((distance + z) tan(fov / 2)) in clip space, so the camera
  // height that puts the front of the footprint on the last pixel row is exact.
  // The scale scales the model, the camera's distance and the canvas together,
  // so the framing is the same at every size.
  const aimAtGround = () => {
    const margin = (2 * GROUND_MARGIN_PX) / engine.getRenderHeight();
    const height = (1 - margin) * (CAMERA_DISTANCE - FOOTPRINT_Z) * scale * Math.tan(CAMERA_FOV / 2);
    camera.position.set(0, height, -CAMERA_DISTANCE * scale);
    camera.setTarget(new Vector3(0, height, 0));
    root.scaling.setAll(scale);
  };

  let container: AssetContainer | undefined;
  let mount: TransformNode | undefined;
  let animations = new Map<string, AssetContainer["animationGroups"][number]>();
  let playing: string | undefined;
  let measured: Proportions | undefined;
  let loadSeq = 0;

  /**
   * The box around every mesh, in the space the nodes hang in now, posed on
   * the first frame of `pose`: a model's bind pose is a T-pose with the arms
   * out, twice as wide as the figure standing, and a skinned mesh's own box
   * is that bind pose until it is refreshed through its skeleton.
   */
  const measure = (loaded: AssetContainer, pose: AssetContainer["animationGroups"][number] | undefined): Bounds => {
    if (pose) {
      pose.start(true, 1);
      pose.goToFrame(pose.from);
    }
    for (const node of loaded.transformNodes) node.computeWorldMatrix(true);
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const mesh of loaded.meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      mesh.computeWorldMatrix(true);
      if (mesh.skeleton) {
        mesh.skeleton.prepare();
        mesh.refreshBoundingInfo({ applySkeleton: true, applyMorph: true });
      }
      const box = mesh.getBoundingInfo().boundingBox;
      for (const axis of ["x", "y", "z"] as const) {
        min[axis] = Math.min(min[axis], box.minimumWorld[axis]);
        max[axis] = Math.max(max[axis], box.maximumWorld[axis]);
      }
    }
    return { min, max };
  };

  return {
    resize(size, nextScale) {
      scale = nextScale;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      engine.resize();
      aimAtGround();
    },
    async show(url, model) {
      const seq = ++loadSeq;
      const loaded = await LoadAssetContainerAsync(url, scene);
      if (seq !== loadSeq) {
        loaded.dispose(); // another model was asked for while this one loaded
        return;
      }
      container?.dispose();
      mount?.dispose();
      container = loaded;
      animations = new Map(loaded.animationGroups.map((g) => [g.name, g]));
      for (const g of loaded.animationGroups) {
        g.stop();
        g.enableBlending = true;
        g.blendingSpeed = 0.08;
      }
      loaded.addAllToScene(); // before any re-parenting: the container checks its hierarchy here
      // Fit: as modelled, measure; then centre it, put its feet at y = 0 and
      // scale it to the spec's height; then turn it to face +z; then hang it
      // under the root, which carries the pet's own turn and scale.
      const fit = new TransformNode("fit", scene);
      for (const node of loaded.rootNodes) node.parent = fit;
      const pose = animations.get(clipFor(model, "idle").name);
      const as = measure(loaded, pose);
      pose?.stop();
      const k = model.height ? model.height / (as.max.y - as.min.y) : 1;
      const cx = (as.min.x + as.max.x) / 2;
      const cz = (as.min.z + as.max.z) / 2;
      fit.scaling.setAll(k);
      fit.position.set(-cx * k, -as.min.y * k, -cz * k);
      const turn = new TransformNode("turn", scene);
      turn.rotation.y = forwardYaw(model.forward);
      fit.parent = turn;
      turn.parent = root;
      mount = turn;
      const fitted: Bounds = {
        min: { x: (as.min.x - cx) * k, y: 0, z: (as.min.z - cz) * k },
        max: { x: (as.max.x - cx) * k, y: (as.max.y - as.min.y) * k, z: (as.max.z - cz) * k },
      };
      measured = proportionsOf(fitted, yawFor(1) + turn.rotation.y);
      playing = undefined;
    },
    has: (clip) => animations.has(clip),
    clipSeconds(clip) {
      const g = animations.get(clip);
      if (!g) return undefined;
      const fps = g.targetedAnimations[0]?.animation.framePerSecond ?? 60;
      return (g.to - g.from) / fps;
    },
    proportions: () => measured,
    play(clip, speed) {
      if (clip.name === playing) return;
      animations.get(playing ?? "")?.stop();
      const g = animations.get(clip.name) ?? animations.values().next().value; // a clip the file lacks: the file's first
      g?.start(!clip.once, speed);
      playing = clip.name;
    },
    face(dir) {
      yawTarget = yawFor(dir);
    },
    render(dt) {
      yaw += (yawTarget - yaw) * Math.min(1, dt * 10);
      root.rotation.y = yaw;
      scene.render();
    },
    solidAt(cssX, cssY) {
      return container !== undefined && scene.pick(cssX, cssY, undefined, false).hit;
    },
    dispose() {
      loadSeq++;
      container?.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
