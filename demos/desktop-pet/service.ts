// The contract, and the worker's half: it decides what the pet does next.
// The page animates; the UI thread moves the window and owns which pet it is.

import { defineService } from "@n1h/sweetview/ipc";
import type { HitProbe, Point, Rect } from "@n1h/sweetview/native";
import type { WindowChromeMethods } from "@n1h/sweetview/window-chrome";
import { type Command, type Mood, nextCommand, type Pet } from "@n1h/web-pets/packs/cube-pets/spec";
import type { Settings } from "./settings";

/**
 * Where the pet can live, plus how many window units one CSS pixel of the page
 * is (DPI scale on Windows, 1 on macOS), whether this is a debug run
 * (WEBVIEW_DEBUG=1), and whether the pet should hold its rest pose and never
 * change mood (PET_STILL=1, for testing hit boxes against a known picture).
 */
export type ScreenArea = Rect & { scale: number; debug: boolean; still: boolean };

/** The moods and commands are @n1h/web-pets'; they are part of this contract. */
export type { Command, Mood };

export type WorkerMethods = {
  /** A new behaviour for this pet, picked at random; the worker remembers the pet for its own nudges. */
  "pet.next": [Pet, Command];
};

/** Answered on the UI thread (app.ts), which owns the window and the tray menu. The settings window's page-drawn chrome adds `window.*` (sweetview/window-chrome). */
export type UiMethods = WindowChromeMethods & {
  /** The window's new top-left, in window units. */
  "pet.move": [Point, void];
  /** The window's new size, in window units (the pet's scale changed). */
  "pet.resize": [{ width: number; height: number }, void];
  /**
   * Where the pet is on screen, as window-local polygons in window units,
   * flat: a point count, then that many x, y pairs, per polygon. Clicks
   * anywhere else in the window fall through. Sent a few times a second: the
   * convex hull of each mesh's projected bounding box, its exact silhouette
   * for the box-shaped parts these models are made of.
   */
  "hit.regions": [number[], void];
  /** The page's exact answer to `hit.probe`: is the pet's geometry under that point? */
  "hit.answer": [{ id: number; solid: boolean }, void];
  /** Where the pet can live: the whole primary monitor, in window units. The pet walks on its very bottom edge, over the taskbar or Dock. */
  "screen.area": [void, ScreenArea];
  /** The monitor under a point (the nearest one when it is on none), in window units: asked on every drop, so a pet carried to another monitor lands on, and then walks along, that monitor's bottom edge. */
  "screen.at": [Point, ScreenArea];
  /** Which pet the tray menu has picked (random at launch). */
  "pet.current": [void, Pet];
  /** Pick another pet (the settings page); everyone hears `pet.select`. */
  "pet.choose": [Pet, void];
  "settings.get": [void, Settings];
  /** Change some settings; applied, saved, and broadcast as `settings.changed`. The reply is the clamped result. */
  "settings.set": [Partial<Settings>, Settings];
  /** A line for the app's stdout; the page sends its frame rate every few seconds in debug runs. */
  "debug.log": [string, void];
  /** Something in the pet page failed (an uncaught error, WebGL refused, a model that would not load): appended to `pet.log` beside `settings.json`, the first one also shown as a notification, so a pet that never appears says why. */
  "pet.fault": [string, void];
  "pet.quit": [void, void];
};

export type Methods = WorkerMethods & UiMethods;

export type Events = {
  /** The worker changed its mind. */
  "pet.command": Command;
  /** The tray menu picked another pet. */
  "pet.select": Pet;
  /** Settings changed, from the settings page or the tray. */
  "settings.changed": Settings;
  /** The cursor is inside one of the pet's polygons, at this window-local point: is it really on the pet? Answer with `hit.answer`. */
  "hit.probe": HitProbe;
};

export const createService = () =>
  defineService<WorkerMethods, Events>((emit) => {
    // The pet the page last asked about; the nudges below are for it. Until the page asks, there is nothing to nudge.
    let current: Pet | undefined;
    // Nudge the pet now and then even if it has not asked.
    const timer = setInterval(() => {
      if (current) emit("pet.command", nextCommand(current));
    }, 9000);
    return {
      methods: {
        "pet.next": (pet) => {
          current = pet;
          return nextCommand(pet);
        },
      },
      dispose: () => clearInterval(timer),
    };
  });
