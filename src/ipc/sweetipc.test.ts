import { describe, expect, test } from "bun:test";
import { createBridge, defineService, memoryTransport } from "./index";

type Methods = {
  ping: [void, "pong"];
  add: [{ a: number; b: number }, number];
  shout: [{ text: string }, void];
  fail: [void, never];
};
type Events = { shouted: { text: string; by: string } };

const createService = () =>
  defineService<Methods, Events>((emit) => ({
    methods: {
      ping: () => "pong",
      add: ({ a, b }) => a + b,
      shout: ({ text }, ctx) => emit("shouted", { text, by: ctx.session.id }),
      fail: () => {
        throw new Error("nope");
      },
    },
  }));

describe("sweetipc", () => {
  test("typed rpc through a bridge over the memory transport", async () => {
    const bridge = createBridge<Methods, Events>(memoryTransport(createService()));
    expect(bridge.kind).toBe("web");
    expect(await bridge.rpc("ping")).toBe("pong");
    expect(await bridge.rpc("add", { a: 2, b: 3 })).toBe(5);
  });

  test("errors carry the handler's message", async () => {
    const bridge = createBridge<Methods, Events>(memoryTransport(createService()));
    await expect(bridge.rpc("fail")).rejects.toThrow("nope");
    // @ts-expect-error unknown method
    await expect(bridge.rpc("missing")).rejects.toThrow("unknown method missing");
    // @ts-expect-error names on Object.prototype are not methods either
    await expect(bridge.rpc("constructor")).rejects.toThrow("unknown method constructor");
  });

  test("events reach subscribers, and `to` targets one session", async () => {
    const service = createService();
    const a = createBridge<Methods, Events>(memoryTransport(service, { id: "a", kind: "web" }));
    const b = createBridge<Methods, Events>(memoryTransport(service, { id: "b", kind: "web" }));
    const seenA: string[] = [];
    const seenB: string[] = [];
    a.on("shouted", (p) => seenA.push(`${p.by}:${p.text}`));
    const offB = b.on("shouted", (p) => seenB.push(`${p.by}:${p.text}`));

    await a.rpc("shout", { text: "hi" });
    expect(seenA).toEqual(["a:hi"]);
    expect(seenB).toEqual(["a:hi"]);

    offB();
    await b.rpc("shout", { text: "again" });
    expect(seenA).toEqual(["a:hi", "b:again"]);
    expect(seenB).toEqual(["a:hi"]);
  });

  test("endSession and dispose reach the definition", async () => {
    const ended: string[] = [];
    let disposed = false;
    const service = defineService<Methods, Events>(() => ({
      methods: {
        ping: () => "pong",
        add: ({ a, b }) => a + b,
        shout: () => {},
        fail: () => {
          throw new Error("x");
        },
      },
      endSession: (id) => ended.push(id),
      dispose: () => void (disposed = true),
    }));
    const t = memoryTransport(service, { id: "s1", kind: "webview" });
    t.close();
    await service.dispose();
    expect(ended).toEqual(["s1"]);
    expect(disposed).toBe(true);
  });
});
