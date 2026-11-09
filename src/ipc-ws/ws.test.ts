import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBridge, defineService } from "../ipc";
import { wsTransport } from "./client";
import { wsHost } from "./server";

type Methods = {
  ping: [void, "pong"];
  whoami: [void, string];
  shout: [{ text: string }, void];
  whisper: [{ text: string }, void];
  fail: [void, never];
};
type Events = { shouted: { text: string } };

const ended: string[] = [];
const service = defineService<Methods, Events>((emit) => ({
  methods: {
    ping: () => "pong",
    whoami: (_, ctx) => `${ctx.session.kind}:${ctx.session.id}`,
    shout: ({ text }) => emit("shouted", { text }),
    whisper: ({ text }, ctx) => emit("shouted", { text }, ctx.session.id),
    fail: () => {
      throw new Error("nope");
    },
  },
  endSession: (id) => ended.push(id),
}));

const host = wsHost(service);
let server: ReturnType<typeof Bun.serve<{ session: { id: string; kind: "web" | "webview" } }>>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") return host.upgrade(req, srv) ? undefined : new Response("no", { status: 400 });
      return new Response("not found", { status: 404 });
    },
    websocket: host.websocket,
  });
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterAll(() => {
  host.close();
  server.stop(true);
});

const connect = () => wsTransport(url);
const nextEvent = <T>(bridge: { on: (name: "shouted", fn: (p: T) => void) => () => void }) =>
  new Promise<T>((resolve) => {
    const off = bridge.on("shouted", (p) => {
      off();
      resolve(p);
    });
  });

describe("sweetipc-ws", () => {
  test("calls made before the socket opens are queued and answered", async () => {
    const t = connect();
    const bridge = createBridge<Methods, Events>(t);
    expect(await bridge.rpc("ping")).toBe("pong");
    expect(await bridge.rpc("whoami")).toMatch(/^web:ws-\d+$/);
    t.close();
  });

  test("handler errors reject with the message", async () => {
    const t = connect();
    const bridge = createBridge<Methods, Events>(t);
    await expect(bridge.rpc("fail")).rejects.toThrow("nope");
    t.close();
  });

  test("broadcast reaches every session, targeted events reach one", async () => {
    const ta = connect();
    const tb = connect();
    const a = createBridge<Methods, Events>(ta);
    const b = createBridge<Methods, Events>(tb);
    await Promise.all([ta.ready, tb.ready]);

    const [ea, eb] = [nextEvent<{ text: string }>(a), nextEvent<{ text: string }>(b)];
    await a.rpc("shout", { text: "all" });
    expect((await ea).text).toBe("all");
    expect((await eb).text).toBe("all");

    let bHeard = false;
    const offB = b.on("shouted", () => (bHeard = true));
    const ea2 = nextEvent<{ text: string }>(a);
    await a.rpc("whisper", { text: "just me" });
    expect((await ea2).text).toBe("just me");
    await Bun.sleep(20);
    expect(bHeard).toBe(false);
    offB();
    ta.close();
    tb.close();
  });

  test("a browser Origin from elsewhere is refused; the page's own origin and non-browsers get in", async () => {
    const httpUrl = `http://127.0.0.1:${server.port}/ws`;
    const upgradeHeaders = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    const foreign = await fetch(httpUrl, { headers: { ...upgradeHeaders, origin: "http://evil.example" } });
    expect(foreign.status).toBe(400);

    const opens = (ws: WebSocket) =>
      new Promise<boolean>((resolve) => {
        ws.addEventListener("open", () => resolve(true));
        ws.addEventListener("error", () => resolve(false));
        ws.addEventListener("close", () => resolve(false));
      });
    const before = host.sessions;
    // @ts-expect-error Bun's WebSocket takes { headers }; the DOM typing only knows protocols
    const own = new WebSocket(url, { headers: { origin: `http://127.0.0.1:${server.port}` } });
    const noOrigin = new WebSocket(url);
    expect(await opens(own)).toBe(true);
    expect(await opens(noOrigin)).toBe(true);
    expect(host.sessions).toBe(before + 2);
    own.close();
    noOrigin.close();
    await Bun.sleep(30);
    expect(host.sessions).toBe(before);
  });

  test("closing the socket ends the session and rejects what is in flight", async () => {
    const t = connect();
    const bridge = createBridge<Methods, Events>(t);
    const id = (await bridge.rpc("whoami")).split(":")[1]!;
    const closed = new Promise<void>((resolve) => t.onClose(resolve));
    t.close();
    await closed;
    await expect(bridge.rpc("ping")).rejects.toThrow("websocket closed");
    await Bun.sleep(20);
    expect(ended).toContain(id);
    expect(host.sessions).toBe(0);
  });
});
