// The page side for Tauri 2: a sweetipc Transport over Tauri's `invoke` and
// its event system. Safe to import in page code: no Bun, no Node, and no
// `@tauri-apps/api` import; it imports types only from sweetipc.
//
// Calls go to one Rust command, TAURI_COMMAND, as `{ frame: CallFrame }`; the
// command returns the ReplyFrame (or null for `seq: null`). Events arrive as
// Tauri events named TAURI_EVENT whose payload is an EventFrame. The Rust side
// is documented in docs/ipc-tauri.md.

import type { CallFrame, EventFrame, ReplyFrame, Transport } from "@n1h/sweetview-ipc";

/** The Tauri command every call frame is sent to, with the single argument `frame`. */
export const TAURI_COMMAND = "sweetview_ipc";
/** The Tauri event every event frame arrives as. */
export const TAURI_EVENT = "sweetview-ipc:event";

/** `invoke` from `@tauri-apps/api/core`, or anything with its signature. */
export type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
/**
 * Listens to an event for this webview only, like `getCurrentWebview().listen`
 * from `@tauri-apps/api/webview`. Not the global `listen` from
 * `@tauri-apps/api/event`: its target `Any` also receives the events the
 * backend sends to other webviews.
 */
export type TauriListen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
export type TauriApi = { invoke: TauriInvoke; listen: TauriListen };

export type TauriTransport = Transport & {
  /** Resolves once the event listener is registered. Calls wait for it, so events a call emits are never missed. */
  readonly ready: Promise<void>;
  /** Unregisters the event listener; later calls reject. Safe to call twice. */
  dispose(): void;
};

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (fn: (value: unknown) => void, once?: boolean) => number;
  metadata?: { currentWebview?: { label?: string } };
};

const g = globalThis as {
  __TAURI_INTERNALS__?: TauriInternals;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener(event: string, id: number): void };
};

/** True when the page runs in a Tauri 2 webview. */
export const isTauri = (): boolean => typeof g.__TAURI_INTERNALS__?.invoke === "function";

/**
 * The Tauri API from `window.__TAURI_INTERNALS__`, which every Tauri 2 webview
 * has (with or without `app.withGlobalTauri`) and which `@tauri-apps/api`
 * itself calls. `listen` is scoped to the current webview.
 */
export function tauriGlobalApi(): TauriApi {
  const internals = g.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") throw new Error("not running inside Tauri");
  const label = internals.metadata?.currentWebview?.label;
  if (typeof label !== "string") throw new Error("Tauri did not report the current webview's label");
  return {
    invoke: (cmd, args) => internals.invoke(cmd, args),
    // what getCurrentWebview().listen from @tauri-apps/api/webview does
    async listen(event, handler) {
      const eventId = (await internals.invoke("plugin:event|listen", { event, target: { kind: "Webview", label }, handler: internals.transformCallback(handler as (value: unknown) => void) })) as number;
      return () => {
        g.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener(event, eventId);
        void internals.invoke("plugin:event|unlisten", { event, eventId }).catch(() => {});
      };
    },
  };
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);

// One counter per page, so two transports on the same page never share a seq.
let seq = 0;

export function tauriTransport(api?: TauriApi): TauriTransport {
  const { invoke, listen } = api ?? tauriGlobalApi();
  const eventListeners = new Set<(name: string, payload: unknown) => void>();
  let disposed = false;
  let unlisten: (() => void) | null = null;

  const ready = listen(TAURI_EVENT, (event) => {
    const frame = event?.payload as EventFrame | null;
    if (disposed || typeof frame !== "object" || frame === null || frame.kind !== "event") return;
    for (const fn of eventListeners) fn(frame.name, frame.payload);
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  ready.catch(() => {}); // reported through every call

  const send = async (frame: CallFrame): Promise<unknown> => {
    await ready;
    if (disposed) throw new Error(`${frame.method}: transport disposed`);
    return invoke(TAURI_COMMAND, { frame });
  };

  return {
    kind: "tauri",
    ready,
    async call(method, params) {
      if (disposed) throw new Error(`${method}: transport disposed`);
      const frame: CallFrame = { kind: "call", seq: String(++seq), method, params };
      let reply: ReplyFrame;
      try {
        reply = (await send(frame)) as ReplyFrame;
      } catch (e) {
        throw new Error(errorMessage(e));
      }
      if (typeof reply !== "object" || reply === null || reply.kind !== "reply") throw new Error(`${method}: the backend answered without a reply frame`);
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    },
    notify(method, params) {
      if (disposed) return;
      send({ kind: "call", seq: null, method, params }).catch((e: unknown) => console.error(`${method} not sent:`, errorMessage(e)));
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      eventListeners.clear();
      unlisten?.();
      unlisten = null;
    },
  };
}
