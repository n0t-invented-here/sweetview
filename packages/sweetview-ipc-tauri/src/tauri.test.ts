// The Tauri transport against a stand-in for a Tauri 2 backend: a fake
// `invoke` and `listen` per webview, behind a TypeScript copy of the Rust side
// of the protocol in docs/ipc-tauri.md. Arguments and payloads are
// JSON-encoded on the way, as Tauri does.

import { afterEach, describe, expect, test } from "bun:test";
import { createBridge, defineService, type Bridge, type CallFrame, type EventFrame, type ReplyFrame, type Service } from "@n1h/sweetview-ipc";
import { TAURI_COMMAND, TAURI_EVENT, isTauri, tauriGlobalApi, tauriTransport, type TauriApi } from "./client";

type Methods = {
  ping: [void, "pong"];
  whoami: [void, string];
  echo: [{ data: string }, { data: string; length: number }];
  shout: [{ text: string }, void];
  whisper: [{ text: string }, void];
  big: [{ size: number }, void];
  fail: [void, never];
};
type Events = { shouted: { text: string }; big: { data: string } };

const json = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const later = () => new Promise((r) => setTimeout(r, 0));

/** The backend: one Service; each webview label is a session, as in the Rust demo. */
function fakeTauri(service: Service<Methods, Events>) {
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>(); // label -> handlers of TAURI_EVENT
  const invoked: { label: string; cmd: string; args: unknown }[] = [];
  const emit = async (label: string, frame: EventFrame) => {
    await later();
    listeners.get(label)?.forEach((fn) => fn({ payload: json(frame) }));
  };
  service.onEvent((name, payload, to) => {
    const frame: EventFrame = { kind: "event", name, payload };
    for (const label of listeners.keys()) if (to === undefined || to === label) void emit(label, frame);
  });
  const webview = (label: string): TauriApi => ({
    async invoke(cmd, args) {
      invoked.push({ label, cmd, args });
      await later();
      if (cmd !== TAURI_COMMAND) throw `command ${cmd} not found`; // Tauri rejects with a string
      const frame = json(args)?.frame as CallFrame;
      try {
        const result = await service.call(frame.method as never, frame.params as never, { session: { id: label, kind: "tauri" } });
        return frame.seq === null ? null : json({ kind: "reply", seq: frame.seq, ok: true, result } satisfies ReplyFrame);
      } catch (err) {
        return frame.seq === null ? null : ({ kind: "reply", seq: frame.seq, ok: false, error: (err as Error).message } satisfies ReplyFrame);
      }
    },
    async listen(event, handler) {
      await later();
      if (event !== TAURI_EVENT) throw new Error(`unexpected event ${event}`);
      let set = listeners.get(label);
      if (!set) listeners.set(label, (set = new Set()));
      set.add(handler);
      return () => set.delete(handler);
    },
  });
  return { webview, invoked, listenerCount: (label: string) => listeners.get(label)?.size ?? 0 };
}

function setup() {
  const notified: string[] = [];
  const service = defineService<Methods, Events>((emit) => ({
    methods: {
      ping: () => "pong",
      whoami: (_, ctx) => `${ctx.session.kind}:${ctx.session.id}`,
      echo: ({ data }) => ({ data, length: data.length }),
      shout: ({ text }) => {
        notified.push(text);
        emit("shouted", { text });
      },
      whisper: ({ text }, ctx) => emit("shouted", { text }, ctx.session.id),
      big: ({ size }) => emit("big", { data: "x".repeat(size) }),
      fail: () => {
        throw new Error("nope");
      },
    },
  }));
  const tauri = fakeTauri(service);
  const open = (label: string) => {
    const transport = tauriTransport(tauri.webview(label));
    return { transport, bridge: createBridge<Methods, Events>(transport) };
  };
  return { tauri, open, notified };
}

const nextEvent = <N extends keyof Events>(bridge: Bridge<Methods, Events>, name: N) =>
  new Promise<Events[N]>((resolve) => {
    const off = bridge.on(name, (p) => {
      off();
      resolve(p);
    });
  });

describe("sweetview-ipc-tauri", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (globalThis as Record<string, unknown>).__TAURI__;
  });

  test("a call is one invoke of sweetview_ipc carrying the frame, and resolves with the reply's result", async () => {
    const { open, tauri } = setup();
    const { bridge, transport } = open("main");
    expect(transport.kind).toBe("tauri");
    expect(await bridge.rpc("ping")).toBe("pong");
    expect(await bridge.rpc("whoami")).toBe("tauri:main");
    const sent = tauri.invoked.at(-1)!;
    expect(sent.cmd).toBe("sweetview_ipc");
    expect(sent.args).toEqual({ frame: { kind: "call", seq: expect.any(String), method: "whoami", params: null } });
  });

  test("an error reply rejects with its message; a failed invoke rejects with Tauri's error", async () => {
    const { open } = setup();
    const { bridge } = open("main");
    await expect(bridge.rpc("fail")).rejects.toThrow("nope");
    const broken = tauriTransport({ invoke: async () => Promise.reject("command sweetview_ipc not found"), listen: async () => () => {} });
    await expect(broken.call("ping", null)).rejects.toThrow("command sweetview_ipc not found");
    const wrong = tauriTransport({ invoke: async () => "not a frame", listen: async () => () => {} });
    await expect(wrong.call("ping", null)).rejects.toThrow("without a reply frame");
  });

  test("notify sends seq null and runs the handler", async () => {
    const { open, tauri, notified } = setup();
    const { bridge } = open("main");
    const shouted = nextEvent(bridge, "shouted");
    bridge.notify("shout", { text: "hi" });
    expect(await shouted).toEqual({ text: "hi" });
    expect(notified).toEqual(["hi"]);
    expect((tauri.invoked.at(-1)!.args as { frame: CallFrame }).frame.seq).toBeNull();
  });

  test("broadcast events reach every webview, targeted events reach one", async () => {
    const { open } = setup();
    const a = open("a");
    const b = open("b");
    await Promise.all([a.transport.ready, b.transport.ready]);
    const both = Promise.all([nextEvent(a.bridge, "shouted"), nextEvent(b.bridge, "shouted")]);
    await a.bridge.rpc("shout", { text: "all" });
    expect(await both).toEqual([{ text: "all" }, { text: "all" }]);

    const seenByB: unknown[] = [];
    const offB = b.bridge.on("shouted", (p) => seenByB.push(p));
    const toA = nextEvent(a.bridge, "shouted");
    await a.bridge.rpc("whisper", { text: "just a" });
    expect(await toA).toEqual({ text: "just a" });
    await later();
    expect(seenByB).toEqual([]);
    offB();
  });

  test("a payload over 1 MB crosses both ways, and as an event", async () => {
    const { open } = setup();
    const { bridge } = open("main");
    const data = "é".repeat(600_000) + "z".repeat(200_000); // 1.4 MB of UTF-8
    const out = await bridge.rpc("echo", { data });
    expect(out.length).toBe(data.length);
    expect(out.data === data).toBe(true);
    const big = nextEvent(bridge, "big");
    await bridge.rpc("big", { size: 1_500_000 });
    expect((await big).data.length).toBe(1_500_000);
  });

  test("calls wait for the listener, so an event a call emits is not missed", async () => {
    const { open, tauri } = setup();
    const { bridge } = open("main");
    expect(tauri.listenerCount("main")).toBe(0); // listen has not resolved yet
    const shouted = nextEvent(bridge, "shouted");
    await bridge.rpc("shout", { text: "early" });
    expect(await shouted).toEqual({ text: "early" });
  });

  test("dispose unlistens and later calls reject", async () => {
    const { open, tauri } = setup();
    const { transport } = open("main");
    await transport.ready;
    expect(tauri.listenerCount("main")).toBe(1);
    transport.dispose();
    transport.dispose();
    expect(tauri.listenerCount("main")).toBe(0);
    await expect(transport.call("ping", null)).rejects.toThrow("transport disposed");
  });

  test("a listen that fails makes every call reject with its error", async () => {
    const t = tauriTransport({ invoke: async () => null, listen: () => Promise.reject(new Error("event.listen not allowed")) });
    await expect(t.call("ping", null)).rejects.toThrow("event.listen not allowed");
  });

  test("without an api, the globals are used: __TAURI__ first, then __TAURI_INTERNALS__", async () => {
    expect(isTauri()).toBe(false);
    expect(() => tauriTransport()).toThrow("not running inside Tauri");

    const g = globalThis as Record<string, unknown>;
    const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
    let callback: ((value: unknown) => void) | undefined;
    g.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "plugin:event|listen") return 7;
        if (cmd === TAURI_COMMAND) return { kind: "reply", seq: (args!.frame as CallFrame).seq, ok: true, result: "pong" };
        return null;
      },
      transformCallback: (fn: (value: unknown) => void) => {
        callback = fn;
        return 42;
      },
    };
    expect(isTauri()).toBe(true);
    const t = tauriTransport();
    const bridge = createBridge<Methods, Events>(t);
    expect(await bridge.rpc("ping")).toBe("pong");
    expect(calls[0]).toEqual({ cmd: "plugin:event|listen", args: { event: TAURI_EVENT, target: { kind: "Any" }, handler: 42 } });
    const got = nextEvent(bridge, "shouted");
    callback!({ event: TAURI_EVENT, id: 7, payload: { kind: "event", name: "shouted", payload: { text: "via internals" } } });
    expect(await got).toEqual({ text: "via internals" });
    t.dispose();
    expect(calls.at(-1)).toEqual({ cmd: "plugin:event|unlisten", args: { event: TAURI_EVENT, eventId: 7 } });

    const globalInvoke = async () => ({ kind: "reply", seq: "x", ok: true, result: "from __TAURI__" });
    const globalListen = async () => () => {};
    g.__TAURI__ = { core: { invoke: globalInvoke }, event: { listen: globalListen } };
    const api = tauriGlobalApi();
    expect(api.invoke).toBe(globalInvoke);
    expect(api.listen).toBe(globalListen);
  });
});
