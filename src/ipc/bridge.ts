// The page side of the contract. A Transport is the one thing a host has to
// provide to the frontend; createBridge puts the typed surface on it.

import type { EventMap, MethodMap } from "./service";

export type TransportKind = "webview" | "web";

export interface Transport {
  readonly kind: TransportKind;
  /** Resolves with the result, rejects with an Error carrying the backend's message. */
  call(method: string, params: unknown): Promise<unknown>;
  /** Fire and forget: no reply. */
  notify(method: string, params: unknown): void;
  /** Only events for this session: the transport drops those whose `to` names another one. Nothing is buffered, so a listener added late misses earlier events. */
  onEvent(fn: (name: string, payload: unknown) => void): () => void;
}

export interface Bridge<M extends MethodMap, E extends EventMap> {
  readonly kind: TransportKind;
  rpc<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): Promise<M[K][1]>;
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  on<N extends keyof E & string>(name: N, fn: (payload: E[N]) => void): () => void;
}

export function createBridge<M extends MethodMap, E extends EventMap>(transport: Transport): Bridge<M, E> {
  type Listener = (payload: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  transport.onEvent((name, payload) => listeners.get(name)?.forEach((fn) => fn(payload)));

  return {
    kind: transport.kind,
    rpc: (method, ...params) => transport.call(method, params[0] ?? null) as Promise<never>,
    notify: (method, ...params) => transport.notify(method, params[0] ?? null),
    on(name, fn) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(fn as Listener);
      return () => set.delete(fn as Listener);
    },
  };
}
