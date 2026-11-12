// The page: renders the pet with Babylon.js and runs its little life. Every
// frame it tells the UI thread where the window should be; the OS moves it.
// The model, its texture and this bundle are fetched by relative URL from the
// page's own origin, which the library serves from the executable.

import "./main.css";
import "@babylonjs/loaders/glTF/2.0";
import "@babylonjs/core/Culling/ray"; // scene.pick
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import { convexHull, flattenRegions, hitRegions, packRegions, unpackRegions, type HitPolygon } from "@n1h/sweetview/native/hit-regions";
// (hitRegions and packRegions are only used by the debug self-check below.)
import { petModelPath, type Pet, type PetAnimation } from "../pets";
import type { Command, Events, Methods, Mood, ScreenArea } from "../service";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import { WINDOW_SIZE } from "./config";

const bridge = createBridge<Methods, Events>(webviewTransport());

// Anything that stops the pet from appearing is reported to the UI thread,
// which writes it to pet.log and shows it once: a transparent window with a
// dead page looks like no pet at all, and a compiled exe has no console.
const reported = new WeakSet<object>(); // an error reported here and then rethrown is not reported again by the window's handler
const fault = (what: string, err?: unknown) => {
  if (typeof err === "object" && err !== null) {
    if (reported.has(err)) return;
    reported.add(err);
  }
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : err === undefined ? "" : String(err);
  const line = detail ? `${what}: ${detail}` : what;
  console.error(line);
  bridge.notify("pet.fault", line);
};
window.addEventListener("error", (e) => fault("uncaught error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => fault("unhandled rejection", e.reason));

// ---- scene ----------------------------------------------------------------
// Positions are in window units (physical px on Windows, points on macOS);
// `units` is how many of them one CSS pixel is, learned from screen.area.
// The canvas backing store follows devicePixelRatio so Retina stays crisp.

const canvas = document.getElementById("pet") as HTMLCanvasElement;
const dpr = window.devicePixelRatio || 1;
let units = dpr; // window units per CSS pixel
let settings: Settings = DEFAULT_SETTINGS;
let size = WINDOW_SIZE; // window edge in window units: WINDOW_SIZE times the scale

const engine = (() => {
  try {
    return new Engine(canvas, true, { premultipliedAlpha: false, alpha: true }, true);
  } catch (err) {
    fault("WebGL is not available in this webview, so the pet cannot be drawn", err);
    throw err;
  }
})();
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 0);

// A level look from the pet's own height; the pet faces left or right along
// the screen edge and a touch toward the viewer, so its side and face both show.
const CAMERA_DISTANCE = 4.4;
const CAMERA_FOV = 0.5;
const camera = new TargetCamera("camera", new Vector3(0, 0, -CAMERA_DISTANCE), scene);
camera.fov = CAMERA_FOV;
camera.minZ = 0.1;
const key = new DirectionalLight("key", new Vector3(-0.6, -1, 0.8), scene);
key.intensity = 1.6;
const fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
fill.intensity = 0.9;
fill.groundColor = new Color3(0.45, 0.42, 0.5);

const root = new TransformNode("pet", scene); // the model hangs here; its feet are at y = 0
// The models face +z as loaded, away from the camera at -z, and their faces
// are on the cubes' front, so a pure side view hides them. Facing right is a
// quarter turn plus a bit toward the viewer; facing left is the mirror on the
// far side of pi (facing the camera), so a turn swings the face past the
// viewer, never the back.
const TOWARD = 0.5;
const yawFor = (dir: -1 | 1) => (dir === 1 ? Math.PI / 2 + TOWARD : (3 * Math.PI) / 2 - TOWARD);
let yaw = yawFor(1);

// The model's ground (y = 0 across its footprint) sits on the window's bottom
// edge. With a level camera a ground point at depth z projects to
// -height / ((distance + z) tan(fov / 2)) in clip space, so the camera
// height that puts the front of the footprint on the last pixel row is exact.
// The scale setting scales the model, the camera's distance and the window
// together, so the framing is the same at every size.
const GROUND_MARGIN_PX = 2;
const FOOTPRINT_Z = 0.8; // how far the models reach toward the camera
function aimAtGround() {
  const s = settings.scale;
  const margin = (2 * GROUND_MARGIN_PX) / engine.getRenderHeight();
  const height = (1 - margin) * (CAMERA_DISTANCE - FOOTPRINT_Z) * s * Math.tan(CAMERA_FOV / 2);
  camera.position.set(0, height, -CAMERA_DISTANCE * s);
  camera.setTarget(new Vector3(0, height, 0));
  root.scaling.setAll(s);
}

function sizeCanvas() {
  const cssSize = size / units;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  engine.resize();
  aimAtGround();
}

/** New settings: resize the window and the canvas, rescale the model, keep the feet on the (new) ground. */
function applySettings(next: Settings) {
  settings = next;
  const nextSize = Math.round(WINDOW_SIZE * next.scale);
  if (nextSize !== size) {
    size = nextSize;
    bridge.notify("pet.resize", { width: size, height: size });
    sizeCanvas();
  } else {
    aimAtGround();
  }
  if (state.kind === "ground" || state.kind === "landed") y = groundY();
  x = Math.max(area.x - size * 0.2, Math.min(area.x + area.width - size * 0.8, x));
}

// ---- the model ------------------------------------------------------------

let container: AssetContainer | undefined;
let animations = new Map<PetAnimation, AssetContainer["animationGroups"][number]>();
let playing: PetAnimation | undefined;
let loadSeq = 0;
let shown: Pet | undefined; // the pet on screen (or loading), so the worker picks moods that suit it

async function showPet(pet: Pet) {
  const seq = ++loadSeq;
  shown = pet;
  let loaded: AssetContainer;
  try {
    loaded = await LoadAssetContainerAsync(petModelPath(pet), scene);
  } catch (err) {
    fault(`loading the ${pet} model (${petModelPath(pet)}) failed`, err);
    return;
  }
  if (seq !== loadSeq) {
    loaded.dispose(); // another pet was picked while this one loaded
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
  playing = undefined;
  play(wantedAnimation(), 1);
}

function play(name: PetAnimation, speed: number) {
  if (name === playing) return;
  animations.get(playing ?? name)?.stop();
  animations.get(name)?.start(true, speed);
  playing = name;
}

// ---- state ----------------------------------------------------------------

type State = { kind: "ground"; mood: Mood; dir: -1 | 1; until: number } | { kind: "fall"; vy: number } | { kind: "carried" } | { kind: "landed"; until: number };

let area: ScreenArea = { x: 0, y: 0, width: 1920, height: 1040, scale: dpr, debug: false, still: false };
let x = 0; // window top-left, window units
let y = 0;
let state: State = { kind: "ground", mood: "idle", dir: 1, until: 0 };
let facing: -1 | 1 = 1;
let lastSent = { x: NaN, y: NaN };

const WALK_SPEED = 55; // window units per second at scale 1, matched to the walk cycle
const RUN_SPEED = 150;
const GRAVITY = 2400;
const MAX_THROW = 800;
// `bottom` is in CSS pixels, so it lifts the pet the same visual distance on every monitor, whatever its scale factor.
const groundY = () => area.y + area.height - size - Math.round(settings.bottom * units);

const MOOD_ANIMATION: Record<Mood, PetAnimation> = { idle: "idle", walk: "walk", run: "run", eat: "eat", dance: "dance" };

function wantedAnimation(): PetAnimation {
  if (area.still && state.kind === "ground") return "static"; // the rest pose, for tests
  switch (state.kind) {
    case "ground":
      return MOOD_ANIMATION[state.mood];
    case "carried":
    case "fall":
      return "gesture-negative";
    case "landed":
      return "gesture-positive";
  }
}

function apply(cmd: Command, now: number) {
  state = { kind: "ground", mood: cmd.mood, dir: cmd.dir, until: now + cmd.seconds * 1000 };
  if (cmd.mood === "walk" || cmd.mood === "run") facing = cmd.dir;
}

async function askForNext(now: number) {
  let cmd: Command = { mood: "idle", dir: facing, seconds: 2 }; // when nothing is on screen yet, or the ask fails: idle a moment and ask again
  if (shown) {
    try {
      cmd = await bridge.rpc("pet.next", shown);
    } catch (err) {
      console.error("pet.next failed:", (err as Error).message);
    }
  }
  apply(cmd, now);
}

bridge.on("pet.command", (cmd) => {
  if (state.kind === "ground" && !area.still) apply(cmd, performance.now());
});
bridge.on("pet.select", (pet) => void showPet(pet));
bridge.on("settings.changed", applySettings);
bridge.on("hit.probe", ({ id, x, y }) => bridge.notify("hit.answer", { id, solid: solidAt(x / units, y / units) }));

// ---- click-through ----------------------------------------------------------
// The window is see-through everywhere; clicks land on the pet and fall
// through elsewhere. Two levels decide that. Coarse: polygons sent from here
// a few times a second, the convex hull of every mesh's projected
// bounding-box corners; outside all of them the UI thread passes clicks
// through on its own, instantly, with nothing asked of this page. Exact:
// inside a polygon (a box hull still covers the gap between a cat's ears)
// the UI thread asks for a triangle pick at the cursor (hit.probe) and
// follows the answer (hit.answer) a few milliseconds later. Pointer-down and
// the hand cursor use the same pick, so nothing beside the model ever counts
// as the model, and a stalled page only degrades to hull precision.

const HIT_INTERVAL_MS = 50;
let lastHitAt = 0;
let lastRegionCount = 0;
let lastPacked: Int32Array = new Int32Array(0); // what the UI thread tests against, kept for the debug self-check

/** Is anything of the pet under this point of the canvas (CSS pixels)? Triangle-accurate: a fast check would say yes anywhere in a bounding box. */
const solidAt = (cssX: number, cssY: number): boolean => scene.pick(cssX, cssY, undefined, false).hit;

function sendHitRegions() {
  if (!container) return;
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const viewport = camera.viewport.toGlobal(width, height);
  const transform = scene.getTransformMatrix();
  const toUnits = units / dpr; // render pixels -> window units
  const hulls: HitPolygon[] = [];
  for (const mesh of container.meshes) {
    if (mesh.getTotalVertices() === 0) continue;
    const corners = mesh.getBoundingInfo().boundingBox.vectorsWorld.map((corner) => {
      const p = Vector3.Project(corner, Matrix.IdentityReadOnly, transform, viewport);
      return { x: p.x * toUnits, y: p.y * toUnits };
    });
    const hull = convexHull(corners);
    if (hull.length >= 3) hulls.push(hull);
  }
  const flat = flattenRegions(hulls);
  lastRegionCount = flat.length;
  if (area.debug) lastPacked = packRegions(unpackRegions(flat)); // what the UI thread tests against (rounded like it does), for the self-check
  bridge.notify("hit.regions", flat);
}

// ---- drag: pick the pet up ------------------------------------------------

let grab = { dx: 0, dy: 0 };
let lastDrag = { x: 0, y: 0, t: 0, vx: 0, vy: 0 };

canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 2) return; // right-click: nothing yet
  if (!solidAt(e.offsetX, e.offsetY)) return; // a click that slips through on a transparent spot never picks the pet up
  canvas.setPointerCapture(e.pointerId);
  // screenX/Y are CSS px of the screen; convert to window units.
  grab = { dx: e.screenX * units - x, dy: e.screenY * units - y };
  lastDrag = { x: e.screenX * units, y: e.screenY * units, t: performance.now(), vx: 0, vy: 0 };
  state = { kind: "carried" };
});

canvas.addEventListener("pointermove", (e) => {
  if (state.kind !== "carried") {
    canvas.style.cursor = solidAt(e.offsetX, e.offsetY) ? "grab" : "default"; // the hand only over the model itself
    return;
  }
  canvas.style.cursor = "grabbing";
  const sx = e.screenX * units;
  const sy = e.screenY * units;
  const now = performance.now();
  const dt = Math.max(1, now - lastDrag.t) / 1000;
  const dx = sx - lastDrag.x;
  lastDrag = { x: sx, y: sy, t: now, vx: dx / dt, vy: (sy - lastDrag.y) / dt };
  x = sx - grab.dx;
  y = sy - grab.dy;
  if (Math.abs(dx) > 2) facing = dx < 0 ? -1 : 1;
});

const drop = () => {
  if (state.kind !== "carried") return;
  state = { kind: "fall", vy: Math.max(-MAX_THROW, Math.min(MAX_THROW, lastDrag.vy)) };
  // Dropped on another monitor: that monitor is home now. Asked by the window's
  // centre, where the pet is, not the cursor; the fall and the landing clamp
  // read `area` each frame, so the reply (a round trip of about a millisecond,
  // the fall takes far longer) is in place before the pet touches the ground.
  bridge
    .rpc("screen.at", { x: x + size / 2, y: y + size / 2 })
    .then((screen) => {
      area = screen;
      if (screen.scale !== units) {
        // Another scale factor: the page's CSS pixel changed size under us, so
        // the canvas must be re-fitted to the window or the feet draw below
        // (or above) the window's bottom edge.
        units = screen.scale;
        sizeCanvas();
      }
    })
    .catch((err: Error) => console.error("screen.at failed:", err.message));
};
canvas.addEventListener("pointerup", drop);
canvas.addEventListener("pointercancel", drop);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

/** Debug: over a grid of points, where the coarse hit polygons and a triangle pick disagree. Polygon-but-not-model is what the refiner corrects; model-but-not-polygon would be a click that falls through and must stay 0. */
function hullAccuracy(): string {
  const n = 32;
  let solid = 0;
  let falsePositive = 0; // polygon says yes, pick says no: a click there is taken but does nothing
  let falseNegative = 0; // polygon says no, pick says yes: a click on the model falls through
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const cssX = ((gx + 0.5) / n) * canvas.clientWidth;
      const cssY = ((gy + 0.5) / n) * canvas.clientHeight;
      const picked = solidAt(cssX, cssY);
      const polygon = hitRegions(lastPacked, cssX * units, cssY * units);
      if (picked) solid++;
      if (polygon && !picked) falsePositive++;
      if (!polygon && picked) falseNegative++;
    }
  }
  return `grid ${n * n}: model ${solid}, polygon-but-not-model ${falsePositive} (refined by pick), model-but-not-polygon ${falseNegative}`;
}

// ---- loop -----------------------------------------------------------------

let last = performance.now();
let frames = 0;
let fpsSince = performance.now();

function step() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  let speed = 1;
  switch (state.kind) {
    case "ground": {
      y = groundY();
      if (now >= state.until) {
        if (!area.still) void askForNext(now);
        state = { ...state, until: Infinity }; // wait for the answer (forever, when held still)
      }
      if (state.mood === "walk" || state.mood === "run") {
        x += state.dir * (state.mood === "walk" ? WALK_SPEED : RUN_SPEED) * settings.scale * dt;
        const minX = area.x - size * 0.2;
        const maxX = area.x + area.width - size * 0.8;
        if (x < minX || x > maxX) {
          x = Math.max(minX, Math.min(maxX, x));
          state = { ...state, dir: (-state.dir) as -1 | 1 };
          facing = state.dir;
        }
      }
      break;
    }
    case "fall": {
      state.vy += GRAVITY * dt;
      y += state.vy * dt;
      if (y >= groundY()) {
        y = groundY();
        x = Math.max(area.x - size * 0.2, Math.min(area.x + area.width - size * 0.8, x)); // dropped off the edge: back on screen
        state = { kind: "landed", until: now + 1200 };
      }
      break;
    }
    case "landed":
      if (now >= state.until) state = { kind: "ground", mood: "idle", dir: facing, until: now + 800 };
      break;
    case "carried":
      speed = 1.5;
      break;
  }

  play(wantedAnimation(), speed);

  yaw += (yawFor(facing) - yaw) * Math.min(1, dt * 10);
  root.rotation.y = yaw;

  scene.render();

  if (now - lastHitAt >= HIT_INTERVAL_MS) {
    lastHitAt = now;
    sendHitRegions();
  }

  // Frame rate, and how well the hit polygons match a real pick, to the app's stdout, in debug runs.
  frames++;
  if (area.debug && now - fpsSince >= 2000) {
    bridge.notify("debug.log", `fps ${((frames * 1000) / (now - fpsSince)).toFixed(1)}  ${playing ?? "-"}  ${hullAccuracy()}`);
    frames = 0;
    fpsSince = now;
  }

  const rx = Math.round(x);
  const ry = Math.round(y);
  if (rx !== lastSent.x || ry !== lastSent.y) {
    lastSent = { x: rx, y: ry };
    bridge.notify("pet.move", { x: rx, y: ry });
  }
}

// ---- start ----------------------------------------------------------------

Promise.all([bridge.rpc("screen.area"), bridge.rpc("pet.current"), bridge.rpc("settings.get")])
  .then(([screen, pet, saved]) => {
    area = screen;
    units = screen.scale;
    settings = saved;
    size = Math.round(WINDOW_SIZE * saved.scale);
    sizeCanvas();
    x = area.x + Math.round(area.width * 0.6);
    y = groundY();
    state = { kind: "ground", mood: "idle", dir: 1, until: performance.now() + 1500 };
    void showPet(pet);
    engine.runRenderLoop(step);
  })
  .catch((err: Error) => fault("the page could not start (screen.area / pet.current / settings.get)", err));
