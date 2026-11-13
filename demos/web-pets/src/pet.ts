// A pet on a page: a see-through canvas the model is drawn on, placed over the
// page and moved every frame as the life says. Pets on the same ground step
// together (herd.ts) and bump into each other. Clicks reach the page through
// the canvas everywhere the model is not; over the model, the hand cursor
// shows and a press picks the pet up.

import { herdFor } from "./herd";
import { BODY, FEET, HEAD, createLife, type Box } from "./life";
import type { PetModel } from "./model";
import { CUBE_PETS, randomPet, type Pet } from "./packs/cube-pets";
import { createPetScene } from "./scene";
import { DEFAULT_PET_SETTINGS, sanitizePetSettings, type PetSettings } from "./settings";

/** The pet's box edge at scale 1, in CSS pixels. */
export const PET_SIZE = 192;

export type Point = { x: number; y: number };

export type PetOptions = {
  /** Which animal: one of the cube pets by name, or any model spec (`PetModel`); a random cube pet when not given. */
  pet?: Pet | PetModel;
  /**
   * Where the pet's centre appears before it falls, in CSS pixels from the
   * top-left of its bounds (the viewport, or `host`). By default somewhere
   * along the top edge, so it drops in from above.
   */
  spawn?: Point;
  scale?: number;
  bottom?: number;
  /**
   * The element the pet lives in: its bounds are the element's box, the pet
   * is positioned inside it (the element becomes `position: relative` when
   * it was static). Without one the pet is fixed to the viewport and stays
   * on screen while the page scrolls.
   */
  host?: HTMLElement;
  /** Where the package's assets folder is served, with a trailing slash; a model loads from `assetsUrl + pack + "/" + file`. `/pets/` by default. */
  assetsUrl?: string;
  /** Stacking of the canvas over the page's content. */
  zIndex?: number;
  /** Something failed after the pet was created (a model that would not load). `console.error` by default. */
  onFault?: (message: string, error?: unknown) => void;
};

export type PetHandle = {
  /** The model on show, and its name. */
  readonly model: PetModel;
  readonly pet: string;
  readonly settings: PetSettings;
  /** The box's top-left in bounds coordinates, and its edge. */
  readonly position: Point;
  readonly size: number;
  /** Switch animal; resolves when the new model is up (or failed and reported). */
  setPet(pet: Pet | PetModel): Promise<void>;
  /** Change the scale or the bottom; the reply is the clamped result. */
  setSettings(patch: Partial<PetSettings>): PetSettings;
  /** Put the pet's centre here and let it fall. */
  spawn(at: Point): void;
  dispose(): void;
};

/** A name is one of the cube pets; a spec is itself; nothing is a random cube pet. */
export const resolveModel = (pet: Pet | PetModel | undefined): PetModel => (pet === undefined ? CUBE_PETS[randomPet()] : typeof pet === "string" ? CUBE_PETS[pet] : pet);

/** Creates the canvas and starts the pet. Throws when WebGL is not available. */
export function createPet(options: PetOptions = {}): PetHandle {
  const fault = options.onFault ?? ((message: string, error?: unknown) => console.error(message, error ?? ""));
  const host = options.host;
  if (host && getComputedStyle(host).position === "static") host.style.position = "relative";
  const assetsUrl = options.assetsUrl ?? "/pets/";

  const canvas = document.createElement("canvas");
  canvas.className = "web-pet";
  Object.assign(canvas.style, {
    position: host ? "absolute" : "fixed",
    left: "0",
    top: "0",
    display: "block",
    pointerEvents: "none", // on only while the pointer is over the model (see hover below)
    touchAction: "none",
    userSelect: "none",
    willChange: "transform",
    zIndex: String(options.zIndex ?? 2147483000),
  } satisfies Partial<CSSStyleDeclaration>);
  (host ?? document.body).append(canvas);

  let scene: ReturnType<typeof createPetScene>;
  try {
    scene = createPetScene(canvas);
  } catch (err) {
    canvas.remove();
    throw err;
  }

  let model = resolveModel(options.pet);
  let settings = sanitizePetSettings({ scale: options.scale, bottom: options.bottom }, DEFAULT_PET_SETTINGS);
  let size = Math.round(PET_SIZE * settings.scale);

  const bounds = (): Box => (host ? { x: 0, y: 0, width: host.clientWidth, height: host.clientHeight } : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
  const life = createLife({
    bounds,
    size: () => size,
    scale: () => settings.scale,
    bottom: () => settings.bottom,
    model: () => model,
    has: (clip) => scene.has(clip),
    clipSeconds: (clip) => scene.clipSeconds(clip),
    body: () => scene.proportions()?.body ?? BODY,
    head: () => scene.proportions()?.head ?? HEAD,
    feet: () => scene.proportions()?.feet ?? FEET,
  });

  scene.resize(size, settings.scale);

  const spawn = (at: Point) => life.spawn(at.x - size / 2, at.y - size / 2);
  spawn(options.spawn ?? { x: bounds().width * (0.2 + Math.random() * 0.6), y: -size / 2 });

  const show = async (next: Pet | PetModel) => {
    model = resolveModel(next);
    const url = `${assetsUrl}${model.pack}/${model.file}`;
    try {
      await scene.show(url, model);
      const measured = scene.proportions();
      if (measured) Object.assign(canvas.dataset, { model: model.name, body: measured.body.toFixed(3), head: measured.head.toFixed(3), feet: measured.feet.toFixed(3) }); // what the page can read about the fit
    } catch (err) {
      fault(`loading the ${model.name} model (${url}) failed`, err);
    }
  };

  // ---- pointer: a press on the model picks it up; everywhere else the canvas is not there ----
  // The canvas takes no pointer events, so the page under it works as if it were
  // not there. On every move the pointer is tested against the model with a
  // triangle pick; over the model the canvas takes events and shows the hand,
  // so the press lands here. One move of lag, never a stolen click.

  /** The pointer's place in bounds coordinates. */
  const toBounds = (e: PointerEvent): Point => {
    if (!host) return { x: e.clientX, y: e.clientY };
    const r = host.getBoundingClientRect();
    return { x: e.clientX - r.left + host.scrollLeft, y: e.clientY - r.top + host.scrollTop };
  };
  const overModel = (e: PointerEvent): boolean => {
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    return cx >= 0 && cy >= 0 && cx < r.width && cy < r.height && scene.solidAt(cx, cy);
  };
  const hover = (e: PointerEvent) => {
    if (life.state.kind === "carried") return;
    const on = overModel(e);
    canvas.style.pointerEvents = on ? "auto" : "none";
    canvas.style.cursor = on ? "grab" : "";
  };
  document.addEventListener("pointermove", hover, { passive: true });

  let grab = { dx: 0, dy: 0 };
  let lastDrag = { x: 0, y: 0, t: 0, vy: 0 };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !overModel(e)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = toBounds(e);
    grab = { dx: p.x - life.x, dy: p.y - life.y };
    lastDrag = { x: p.x, y: p.y, t: performance.now(), vy: 0 };
    canvas.style.cursor = "grabbing";
    life.pickUp();
  };
  const onMove = (e: PointerEvent) => {
    if (life.state.kind !== "carried") return;
    const p = toBounds(e);
    const now = performance.now();
    const dt = Math.max(1, now - lastDrag.t) / 1000;
    const dx = p.x - lastDrag.x;
    lastDrag = { x: p.x, y: p.y, t: now, vy: (p.y - lastDrag.y) / dt };
    life.carryTo(p.x - grab.dx, p.y - grab.dy);
    if (Math.abs(dx) > 2) life.face(dx < 0 ? -1 : 1);
  };
  const onUp = (e: PointerEvent) => {
    if (life.state.kind !== "carried") return;
    life.drop(lastDrag.vy);
    canvas.style.cursor = "grab";
    hover(e);
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- loop: the herd steps every pet on this ground, then each draws itself ----
  let lastPlaced = { x: NaN, y: NaN };
  const leave = herdFor(host ?? document).add({
    life,
    frame(dt) {
      scene.play(life.animation(), life.animationSpeed());
      scene.face(life.facing);
      scene.render(dt);
      const rx = Math.round(life.x);
      const ry = Math.round(life.y);
      if (rx !== lastPlaced.x || ry !== lastPlaced.y) {
        lastPlaced = { x: rx, y: ry };
        canvas.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      }
    },
  });

  void show(model);

  return {
    get model() {
      return model;
    },
    get pet() {
      return model.name;
    },
    get settings() {
      return settings;
    },
    get position() {
      return { x: life.x, y: life.y };
    },
    get size() {
      return size;
    },
    setPet: show,
    setSettings(patch) {
      settings = sanitizePetSettings(patch, settings);
      const nextSize = Math.round(PET_SIZE * settings.scale);
      if (nextSize !== size) {
        // Grow and shrink about the feet, so a standing pet stays where it stood.
        const feetX = life.x + size / 2;
        size = nextSize;
        if (life.state.kind === "carried") life.carryTo(feetX - size / 2, life.y);
        else if (life.state.kind === "fall") life.spawn(feetX, life.y);
      }
      scene.resize(size, settings.scale);
      return settings;
    },
    spawn,
    dispose() {
      leave();
      document.removeEventListener("pointermove", hover);
      scene.dispose();
      canvas.remove();
    },
  };
}
