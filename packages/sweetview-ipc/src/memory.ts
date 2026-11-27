// A Transport straight onto a Service in the same process. For tests, and for
// a frontend rendered in plain Bun without any host.

import type { Transport } from "./bridge";
import type { EventMap, MethodMap, Service, Session } from "./service";

let nextId = 1;

export function memoryTransport<M extends MethodMap, E extends EventMap>(
  service: Service<M, E>,
  session: Session = { id: `memory-${nextId++}`, kind: "web" },
): Transport & { dispose(): void } {
  const ctx = { session };
  const listeners = new Set<(name: string, payload: unknown) => void>();
  const off = service.onEvent((name, payload, to) => {
    if (to !== undefined && to !== session.id) return;
    for (const fn of listeners) fn(name, payload);
  });
  let disposed = false;
  const call = (method: string, params: unknown): Promise<unknown> => {
    if (disposed) return Promise.reject(new Error(`${method}: transport disposed`));
    return service.call(method as keyof M & string, params as never, ctx);
  };
  return {
    kind: session.kind,
    call,
    notify: (method, params) => {
      if (disposed) return;
      void call(method, params).catch(() => {});
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      listeners.clear();
      service.endSession(session.id);
    },
  };
}
