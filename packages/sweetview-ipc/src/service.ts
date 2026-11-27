// The backend side of the contract. A Service is transport-free: no sockets,
// no window handles, no seq numbers. Hosts (sweetipc-ws, sweetview) wrap one.

/** `void` params mean "no argument". */
export type MethodMap = Record<string, [params: unknown, result: unknown]>;
/** event name -> payload */
export type EventMap = Record<string, unknown>;

export type SessionKind = "webview" | "web";
export type Session = { id: string; kind: SessionKind };
export type Ctx = { session: Session };

/** One event as a discriminated union, so a listener can switch on `name` and get a typed `payload`. */
export type AnyEvent<E extends EventMap> = { [N in keyof E & string]: { name: N; payload: E[N] } }[keyof E & string];

/** Send an event to every session, or to one when `to` is given. */
export type Emit<E extends EventMap> = <N extends keyof E & string>(name: N, payload: E[N], to?: string) => void;

export interface Service<M extends MethodMap, E extends EventMap> {
  call<K extends keyof M & string>(method: K, params: M[K][0], ctx: Ctx): Promise<M[K][1]>;
  onEvent(fn: (name: keyof E & string, payload: E[keyof E], to?: string) => void): () => void;
  /** A client went away: drop anything held for that session. */
  endSession(sessionId: string): void;
  /** The process is shutting down. */
  dispose(): Promise<void>;
}

export type Handlers<M extends MethodMap> = {
  [K in keyof M & string]: (params: M[K][0], ctx: Ctx) => M[K][1] | Promise<M[K][1]>;
};

export type ServiceDefinition<M extends MethodMap> = {
  methods: Handlers<M>;
  endSession?: (sessionId: string) => void;
  dispose?: () => void | Promise<void>;
};

/**
 * Build a Service from a handler table. `setup` receives `emit` so handlers
 * and background work can push events.
 *
 *   export const createService = () => defineService<Methods, Events>((emit) => ({ methods: { ... } }));
 */
export function defineService<M extends MethodMap, E extends EventMap>(setup: (emit: Emit<E>) => ServiceDefinition<M>): Service<M, E> {
  type Listener = (name: keyof E & string, payload: E[keyof E], to?: string) => void;
  const listeners = new Set<Listener>();
  const emit: Emit<E> = (name, payload, to) => {
    for (const fn of listeners) fn(name, payload, to);
  };
  const def = setup(emit);

  return {
    async call(method, params, ctx) {
      // hasOwn: a name like "constructor" or "toString" must not resolve through Object.prototype.
      const handler = Object.hasOwn(def.methods, method) ? (def.methods[method] as (p: unknown, c: Ctx) => unknown) : undefined;
      if (!handler) throw new Error(`unknown method ${method}`);
      return (await handler(params, ctx)) as never;
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    endSession(sessionId) {
      def.endSession?.(sessionId);
    },
    async dispose() {
      try {
        await def.dispose?.();
      } finally {
        listeners.clear();
      }
    },
  };
}
