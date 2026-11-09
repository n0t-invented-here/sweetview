// The page side: a sweetipc Transport over one WebSocket. Calls made before
// the socket opens are queued; when the socket closes, every pending call
// rejects and the transport stays closed (reload the page to reconnect).

import type { Frame, Transport } from "../ipc";

export type WsTransport = Transport & {
  /** Resolves once the socket is open. */
  readonly ready: Promise<void>;
  /** Fires once, when the socket closes for any reason. */
  onClose(fn: () => void): () => void;
  close(): void;
};

/** `ws://` or `wss://` to match the page's own origin, with the given path. */
export function wsUrl(path = "/ws"): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

export function wsTransport(url: string = wsUrl()): WsTransport {
  const ws = new WebSocket(url);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventListeners = new Set<(name: string, payload: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let queue: string[] = [];
  let seq = 0;

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      for (const text of queue) ws.send(text);
      queue = [];
      resolve();
    });
    ws.addEventListener("close", () => {
      reject(new Error("websocket closed"));
      queue = [];
      for (const p of pending.values()) p.reject(new Error("websocket closed"));
      pending.clear();
      for (const fn of closeListeners) fn();
      closeListeners.clear();
    });
  });
  ready.catch(() => {}); // the rejection is reported through pending calls and onClose

  ws.addEventListener("message", (e: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const frame = parsed as Frame;
    if (frame.kind === "reply") {
      const p = pending.get(frame.seq);
      if (!p) return;
      pending.delete(frame.seq);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(frame.error));
    } else if (frame.kind === "event") {
      for (const fn of eventListeners) fn(frame.name, frame.payload);
    }
  });

  const send = (frame: Frame) => {
    const text = JSON.stringify(frame);
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
    else if (ws.readyState === WebSocket.CONNECTING) queue.push(text);
    else throw new Error("websocket closed");
  };

  return {
    kind: "web",
    ready,
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = String(++seq);
        pending.set(id, { resolve, reject });
        try {
          send({ kind: "call", seq: id, method, params });
        } catch (err) {
          pending.delete(id);
          reject(err as Error);
        }
      });
    },
    notify(method, params) {
      try {
        send({ kind: "call", seq: null, method, params });
      } catch (err) {
        console.error(`${method} not sent:`, (err as Error).message);
      }
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    onClose(fn) {
      if (ws.readyState === WebSocket.CLOSED) {
        fn();
        return () => {};
      }
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    close() {
      ws.close();
    },
  };
}
