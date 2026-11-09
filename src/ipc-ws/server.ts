// Hosts a Service behind Bun.serve's websocket handler. One session per
// socket; events are broadcast, or sent to one session when `to` is set.
//
//   const host = wsHost(createService());
//   Bun.serve({
//     fetch(req, server) {
//       if (new URL(req.url).pathname === "/ws") return host.upgrade(req, server) ? undefined : new Response("upgrade failed", { status: 400 });
//       ...
//     },
//     websocket: host.websocket,
//   });

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { CallFrame, EventMap, Frame, MethodMap, ReplyFrame, Service, Session } from "../ipc";

export type WsData = { session: Session };

export type WsHostOptions = {
  /**
   * Which `Origin` values may connect. Browsers do not apply same-origin to
   * WebSockets, so without this any page the user has open could talk to the
   * service. Default: only the page's own origin (Origin host matches the
   * request's Host). Pass a list of origins, or a predicate.
   */
  allowOrigin?: string[] | ((origin: string, req: Request) => boolean);
};

export type WsHost = {
  /** Upgrade a request to a session; returns false when it was not a websocket request or its Origin is not allowed. */
  upgrade(req: Request, server: Server<WsData>): boolean;
  websocket: WebSocketHandler<WsData>;
  /** Number of live sessions. */
  readonly sessions: number;
  /** Close every socket and stop forwarding events. Does not dispose the service. */
  close(): void;
};

export function wsHost<M extends MethodMap, E extends EventMap>(service: Service<M, E>, options: WsHostOptions = {}): WsHost {
  const sockets = new Map<string, ServerWebSocket<WsData>>();
  let nextId = 1;

  const originAllowed = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (origin === null) return true; // not a browser
    const { allowOrigin } = options;
    if (typeof allowOrigin === "function") return allowOrigin(origin, req);
    if (allowOrigin) return allowOrigin.includes(origin);
    try {
      return new URL(origin).host === req.headers.get("host");
    } catch {
      return false;
    }
  };

  const send = (ws: ServerWebSocket<WsData>, frame: Frame) => {
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
    ws.send(text);
  };

  const off = service.onEvent((name, payload, to) => {
    const frame: Frame = { kind: "event", name, payload };
    if (to !== undefined) {
      const ws = sockets.get(to);
      if (ws) send(ws, frame);
      return;
    }
    for (const ws of sockets.values()) send(ws, frame);
  });

  const websocket: WebSocketHandler<WsData> = {
    open(ws) {
      sockets.set(ws.data.session.id, ws);
    },
    async message(ws, raw) {
      let frame: unknown;
      try {
        frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return; // not ours
      }
      // anything that is not a call frame is ignored, including `null` and other non-objects
      if (typeof frame !== "object" || frame === null || (frame as Frame).kind !== "call") return;
      const reply = await handle(frame as CallFrame, ws.data.session);
      if (reply && sockets.get(ws.data.session.id) === ws) send(ws, reply);
    },
    close(ws) {
      const id = ws.data.session.id;
      if (sockets.get(id) === ws) sockets.delete(id);
      service.endSession(id);
    },
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

  return {
    upgrade(req, server) {
      if (!originAllowed(req)) return false;
      const session: Session = { id: `ws-${nextId++}`, kind: "web" };
      return server.upgrade(req, { data: { session } });
    },
    websocket,
    get sessions() {
      return sockets.size;
    },
    close() {
      off();
      for (const ws of sockets.values()) ws.close();
      sockets.clear();
    },
  };
}
