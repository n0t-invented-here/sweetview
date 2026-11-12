// The demo's Service. Notes are shared by every session; each session has its
// own folder watcher, and its watch events go only to it.

import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { defineService, type Service } from "@n1h/sweetview/ipc";
import type { Events, FsChange, Methods, Note, WatchStatus } from "./protocol";

export type * from "./protocol";

type Watch = { watcher: FSWatcher; path: string; batch: FsChange[]; flushScheduled: boolean };

export function createService(): Service<Methods, Events> {
  return defineService<Methods, Events>((emit) => {
    const notes: Note[] = [
      { id: 1, text: "Answered by the service, whichever host is in front of it", createdAt: new Date().toISOString() },
      { id: 2, text: "Rendered with Mantine", createdAt: new Date().toISOString() },
    ];
    let nextNoteId = 3;
    const watches = new Map<string, Watch>();
    const sessions = new Set<string>();

    const status = (session: string): WatchStatus => {
      const w = watches.get(session);
      return { watching: w !== undefined, path: w?.path ?? null };
    };

    function stopWatching(session: string) {
      const w = watches.get(session);
      if (!w) return;
      w.watcher.close();
      watches.delete(session);
    }

    // Changes arrive in bursts (one save = several OS records); coalesce what
    // arrives in the same tick into one event so the UI gets one wakeup.
    function queueChange(session: string, w: Watch, change: FsChange) {
      w.batch.push(change);
      if (w.flushScheduled) return;
      w.flushScheduled = true;
      queueMicrotask(() => {
        w.flushScheduled = false;
        const out = w.batch;
        w.batch = [];
        if (out.length && watches.get(session) === w) emit("fs.change", out, session);
      });
    }

    return {
      methods: {
        "info.get": (_, ctx) => {
          sessions.add(ctx.session.id);
          return {
            bun: Bun.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            compiled: Bun.embeddedFiles.length > 0,
            cwd: process.cwd(),
            host: ctx.session.kind,
            sessions: sessions.size,
          };
        },

        "notes.list": () => notes,
        "notes.add": ({ text }) => {
          const trimmed = text.trim();
          if (!trimmed) throw new Error("text is required");
          const note: Note = { id: nextNoteId++, text: trimmed, createdAt: new Date().toISOString() };
          notes.push(note);
          emit("notes.changed", notes);
          return note;
        },
        "notes.remove": ({ id }) => {
          const i = notes.findIndex((n) => n.id === id);
          if (i === -1) throw new Error(`note ${id} not found`);
          notes.splice(i, 1);
          emit("notes.changed", notes);
        },

        "pick.folder": () => {
          throw new Error("no native folder picker outside the app; type a path instead");
        },
        "ui.theme": () => {},
        "notify.status": () => {
          throw new Error("system notifications come from the desktop app, not the web");
        },
        "notify.onChanges": () => {
          throw new Error("system notifications come from the desktop app, not the web");
        },
        "notify.test": () => {
          throw new Error("system notifications come from the desktop app, not the web");
        },

        "watch.status": (_, ctx) => status(ctx.session.id),
        "watch.stop": (_, ctx) => {
          const session = ctx.session.id;
          stopWatching(session);
          emit("watch.status", status(session), session);
          return status(session);
        },
        "watch.start": ({ path }, ctx) => {
          const session = ctx.session.id;
          stopWatching(session);
          if (!existsSync(path)) throw new Error(`${path} does not exist`);
          const w: Watch = { path, batch: [], flushScheduled: false, watcher: null as unknown as FSWatcher };
          w.watcher = watch(path, { recursive: true }, (eventType, filename) => {
            const rel = filename === null ? "" : String(filename).replaceAll("\\", "/");
            let kind: FsChange["kind"] = "unknown";
            if (eventType === "change") kind = "modified";
            else if (eventType === "rename") kind = existsSync(join(path, rel)) ? "created" : "deleted";
            queueChange(session, w, { kind, path: rel || ".", at: new Date().toISOString() });
          });
          w.watcher.on("error", (err) => {
            console.error("watcher error:", err);
            if (watches.get(session) !== w) return; // a late error from a watcher already replaced
            stopWatching(session);
            emit("watch.status", status(session), session);
          });
          watches.set(session, w);
          emit("watch.status", status(session), session);
          return status(session);
        },
      },

      endSession(session) {
        stopWatching(session);
        sessions.delete(session);
      },

      dispose() {
        for (const session of [...watches.keys()]) stopWatching(session);
      },
    };
  });
}
