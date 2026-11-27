// Hosts a Service in Electron's main process. Each page load in a webContents
// is one session; events are broadcast, or sent to one session when `to` is
// set. It does not import "electron": pass `ipcMain` in. Runs under Node, so it
// uses no Bun API.
//
//   import { ipcMain } from "electron";
//   import { electronHost } from "@n1h/sweetview/ipc-electron/server";
//   const host = electronHost(createService(), ipcMain);

import type { CallFrame, EventMap, Frame, MethodMap, ReplyFrame, Service, Session } from "@n1h/sweetview-ipc";
import { ELECTRON_CHANNEL, ELECTRON_HELLO_CHANNEL } from "./channel";

export { ELECTRON_CHANNEL, ELECTRON_HELLO_CHANNEL } from "./channel";

/** The part of Electron's `WebContents` this module uses. */
export type WebContentsLike = {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
};

/** The part of Electron's `IpcMainEvent` this module uses. */
export type IpcMainEventLike = { sender: WebContentsLike };

type MainListener = (event: IpcMainEventLike, ...args: unknown[]) => void;

/** The part of Electron's `ipcMain` this module uses. */
export type IpcMainLike = {
  on(channel: string, listener: MainListener): unknown;
  removeListener(channel: string, listener: MainListener): unknown;
};

export type ElectronHostOptions = {
  /**
   * Decides whether a message from this sender is served. Default: every
   * sender, which is every page whose window loads the preload script that
   * calls `exposeSweetviewIpc`. Return false to drop the frame silently.
   */
  allowSender?: (event: IpcMainEventLike) => boolean;
};

export type ElectronHost = {
  /** Number of webContents with a live session. */
  readonly sessions: number;
  /** The session currently assigned to a webContents, if any. */
  sessionOf(webContents: WebContentsLike): Session | undefined;
  /** Stops listening and forwarding events and ends every session. Does not dispose the service. Safe to call twice. */
  dispose(): void;
};

type Entry = { wc: WebContentsLike; session: Session };

export function electronHost<M extends MethodMap, E extends EventMap>(service: Service<M, E>, ipcMain: IpcMainLike, options: ElectronHostOptions = {}): ElectronHost {
  const entries = new Map<number, Entry>(); // webContents id -> entry
  const bySession = new Map<string, Entry>();
  let nextId = 1;
  let disposed = false;

  const end = (entry: Entry) => {
    bySession.delete(entry.session.id);
    service.endSession(entry.session.id);
  };

  const startSession = (wc: WebContentsLike): Entry => {
    const old = entries.get(wc.id);
    const entry: Entry = { wc, session: { id: `electron-${nextId++}`, kind: "electron" } };
    entries.set(wc.id, entry);
    bySession.set(entry.session.id, entry);
    if (old) end(old);
    else
      wc.once("destroyed", () => {
        const current = entries.get(wc.id);
        if (!current || disposed) return;
        entries.delete(wc.id);
        end(current);
      });
    return entry;
  };

  const send = (wc: WebContentsLike, frame: Frame) => {
    if (wc.isDestroyed()) return;
    let text: string;
    try {
      text = JSON.stringify(frame);
    } catch (err) {
      // a result or payload JSON cannot carry (a BigInt, a cycle): the page gets an error reply instead of silence
      if (frame.kind === "reply") text = JSON.stringify({ kind: "reply", seq: frame.seq, ok: false, error: `${frame.seq}: the result is not serialisable: ${(err as Error).message}` } satisfies ReplyFrame);
      else {
        console.error(`${frame.kind === "event" ? `event ${frame.name}` : "frame"} is not serialisable:`, (err as Error).message);
        return;
      }
    }
    wc.send(ELECTRON_CHANNEL, text);
  };

  const allowed = (event: IpcMainEventLike) => !disposed && (options.allowSender ? options.allowSender(event) : true);

  const onHello: MainListener = (event) => {
    if (!allowed(event)) return;
    startSession(event.sender);
  };

  const onMessage: MainListener = async (event, raw) => {
    if (!allowed(event) || typeof raw !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // not ours
    }
    // anything that is not a call frame is ignored, including `null` and other non-objects
    if (typeof frame !== "object" || frame === null || (frame as Frame).kind !== "call") return;
    const wc = event.sender;
    // a page whose hello was missed (the host was created after it loaded) gets its session on its first call
    const entry = entries.get(wc.id) ?? startSession(wc);
    const reply = await handle(frame as CallFrame, entry.session);
    // a reload or dispose while the handler ran: that page is gone, so is its reply
    if (reply && !disposed && entries.get(wc.id) === entry) send(wc, reply);
  };

  async function handle(frame: CallFrame, session: Session): Promise<ReplyFrame | null> {
    try {
      const result = await service.call(frame.method as keyof M & string, frame.params as never, { session });
      return frame.seq === null ? null : { kind: "reply", seq: frame.seq, ok: true, result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (frame.seq === null) {
        console.error(`${frame.method} failed:`, error);
        return null;
      }
      return { kind: "reply", seq: frame.seq, ok: false, error };
    }
  }

  const off = service.onEvent((name, payload, to) => {
    const frame: Frame = { kind: "event", name, payload };
    if (to !== undefined) {
      const entry = bySession.get(to);
      if (entry) send(entry.wc, frame);
      return;
    }
    for (const entry of entries.values()) send(entry.wc, frame);
  });

  ipcMain.on(ELECTRON_HELLO_CHANNEL, onHello);
  ipcMain.on(ELECTRON_CHANNEL, onMessage);

  return {
    get sessions() {
      return entries.size;
    },
    sessionOf(wc) {
      return entries.get(wc.id)?.session;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      ipcMain.removeListener(ELECTRON_HELLO_CHANNEL, onHello);
      ipcMain.removeListener(ELECTRON_CHANNEL, onMessage);
      const all = [...entries.values()];
      entries.clear();
      for (const entry of all) end(entry);
    },
  };
}
