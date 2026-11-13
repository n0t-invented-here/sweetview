// The picture: a Babylon.js scene on one canvas, with a level camera aimed so
// the model's feet sit on the canvas's bottom edge at every scale, one model
// at a time, its animations by name, and a triangle pick for "is the pet
// under this point".

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
import type { Direction } from "./moods";
import type { PetAnimation } from "./pets";

export type PetScene = {
  /** Fit the canvas to a `size` CSS-pixel square showing the model at `scale`, feet on the bottom edge. */
  resize(size: number, scale: number): void;
  /** Load the model at this URL and show it in place of the current one. A later call wins over an earlier one still loading. */
  show(url: string): Promise<void>;
  play(name: PetAnimation, speed: number): void;
  /** Turn toward this side; the turn is eased over the next frames. */
  face(dir: Direction): void;
  /** Draw a frame; `dt` in seconds, for the turn. */
  render(dt: number): void;
  /** Is any of the model's geometry under this point of the canvas (CSS pixels)? Triangle-accurate. */
  solidAt(cssX: number, cssY: number): boolean;
  dispose(): void;
};

// A level look from the pet's own height; the pet faces left or right and a
// touch toward the viewer, so its side and face both show.
const CAMERA_DISTANCE = 4.4;
const CAMERA_FOV = 0.5;
// The models face +z as loaded, away from the camera at -z, and their faces
// are on the cubes' front, so a pure side view hides them. Facing right is a
// quarter turn plus a bit toward the viewer; facing left is the mirror on the
// far side of pi (facing the camera), so a turn swings the face past the
// viewer, never the back.
const TOWARD = 0.5;
const yawFor = (dir: Direction) => (dir === 1 ? Math.PI / 2 + TOWARD : (3 * Math.PI) / 2 - TOWARD);
const GROUND_MARGIN_PX = 2;
const FOOTPRINT_Z = 0.8; // how far the models reach toward the camera

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

  const root = new TransformNode("pet", scene); // the model hangs here; its feet are at y = 0
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
  let animations = new Map<PetAnimation, AssetContainer["animationGroups"][number]>();
  let playing: PetAnimation | undefined;
  let loadSeq = 0;

  const play = (name: PetAnimation, speed: number) => {
    if (name === playing) return;
    animations.get(playing ?? name)?.stop();
    animations.get(name)?.start(true, speed);
    playing = name;
  };

  return {
    resize(size, nextScale) {
      scale = nextScale;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      engine.resize();
      aimAtGround();
    },
    async show(url) {
      const seq = ++loadSeq;
      const loaded = await LoadAssetContainerAsync(url, scene);
      if (seq !== loadSeq) {
        loaded.dispose(); // another model was asked for while this one loaded
        return;
      }
      container?.dispose();
      container = loaded;
      for (const node of loaded.rootNodes) node.parent = root;
      animations = new Map(loaded.animationGroups.map((g) => [g.name as PetAnimation, g]));
      for (const g of loaded.animationGroups) {
        g.stop();
        g.enableBlending = true;
        g.blendingSpeed = 0.08;
      }
      loaded.addAllToScene();
      const wanted = playing ?? "idle";
      playing = undefined;
      play(wanted, 1);
    },
    play,
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
