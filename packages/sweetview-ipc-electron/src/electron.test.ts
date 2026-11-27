// The Electron transport, preload and host against a stand-in for Electron's
// IPC: a fake ipcMain, and per window a fake webContents, ipcRenderer and
// contextBridge. Messages cross asynchronously and are structured-cloned, as
// Electron does.

import { describe, expect, test } from "bun:test";
import { createBridge, defineService, type Bridge } from "@n1h/sweetview-ipc";
import { ELECTRON_API_KEY, ELECTRON_CHANNEL, type SweetviewIpcApi } from "./channel";
import { electronTransport, isElectron } from "./client";
import { exposeSweetviewIpc } from "./preload";
import { electronHost, type IpcMainEventLike, type IpcMainLike, type WebContentsLike } from "./server";

type Listener = (event: never, ...args: unknown[]) => void;

function fakeElectron() {
  const main = new Map<string, Set<Listener>>();
  const ipcMain: IpcMainLike = {
    on(channel, fn) {
      let set = main.get(channel);
      if (!set) main.set(channel, (set = new Set()));
      set.add(fn as Listener);
    },
    removeListener(channel, fn) {
      main.get(channel)?.delete(fn as Listener);
    },
  };
  let nextWc = 1;

  /** One BrowserWindow: its webContents in main, and its preload's ipcRenderer and contextBridge. */
  function window() {
    const renderer = new Map<string, Set<Listener>>();
    const destroyedListeners: (() => void)[] = [];
    const sentToPage: string[] = [];
    let destroyed = false;
    const world: Record<string, unknown> = {};
    const wc: WebContentsLike = {
      id: nextWc++,
      send(channel, ...args) {
        if (destroyed) throw new Error("Object has been destroyed");
        const copy = structuredClone(args);
        if (channel === ELECTRON_CHANNEL) sentToPage.push(copy[0] as string);
        setTimeout(() => renderer.get(channel)?.forEach((fn) => fn({} as never, ...copy)), 0);
      },
      isDestroyed: () => destroyed,
      once(_event, fn) {
        destroyedListeners.push(fn);
      },
    };
    const ipcRenderer = {
      send(channel: string, ...args: unknown[]) {
        const copy = structuredClone(args);
        const event: IpcMainEventLike = { sender: wc };
        setTimeout(() => main.get(channel)?.forEach((fn) => fn(event as never, ...copy)), 0);
      },
      on(channel: string, fn: Listener) {
        let set = renderer.get(channel);
        if (!set) renderer.set(channel, (set = new Set()));
        set.add(fn);
      },
      removeListener(channel: string, fn: Listener) {
        renderer.get(channel)?.delete(fn);
      },
    };
    const contextBridge = {
      exposeInMainWorld(key: string, api: unknown) {
        world[key] = api;
      },
    };
    /** Runs the preload, as each page load does. */
    const load = () => {
      renderer.clear();
      exposeSweetviewIpc({ contextBridge, ipcRenderer });
      return world[ELECTRON_API_KEY] as SweetviewIpcApi;
    };
    const destroy = () => {
      destroyed = true;
      for (const fn of destroyedListeners.splice(0)) fn();
    };
    return { wc, load, destroy, sentToPage, world };
  }
  return { ipcMain, window, listenerCount: (channel: string) => main.get(channel)?.size ?? 0 };
}

type Methods = {
  ping: [void, "pong"];
  whoami: [void, string];
  echo: [{ data: string }, { data: string; length: number }];
  shout: [{ text: string }, void];
  whisper: [{ text: string }, void];
  big: [{ size: number }, void];
  fail: [void, never];
  bigint: [void, bigint];
};
type Events = { shouted: { text: string }; big: { data: string } };

function setup() {
  const ended: string[] = [];
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
      bigint: () => 1n,
    },
    endSession: (id) => ended.push(id),
  }));
  const electron = fakeElectron();
  const host = electronHost(service, electron.ipcMain);
  const open = () => {
    const win = electron.window();
    const api = win.load();
    const transport = electronTransport(api);
    return { win, transport, bridge: createBridge<Methods, Events>(transport) };
  };
  return { service, host, electron, open, ended, notified };
}

const nextEvent = <N extends keyof Events>(bridge: Bridge<Methods, Events>, name: N) =>
  new Promise<Events[N]>((resolve) => {
    const off = bridge.on(name, (p) => {
      off();
      resolve(p);
    });
  });

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("sweetview-ipc-electron", () => {
  test("a call gets its reply, in a session of kind electron", async () => {
    const { open, host } = setup();
    const { bridge, transport } = open();
    expect(transport.kind).toBe("electron");
    expect(await bridge.rpc("ping")).toBe("pong");
    expect(await bridge.rpc("whoami")).toMatch(/^electron:electron-\d+$/);
    expect(host.sessions).toBe(1);
  });

  test("a handler error rejects with its message", async () => {
    const { open } = setup();
    const { bridge, transport } = open();
    await expect(bridge.rpc("fail")).rejects.toThrow("nope");
    await expect(transport.call("nosuch", null)).rejects.toThrow("unknown method nosuch");
  });

  test("a result JSON cannot carry becomes an error reply", async () => {
    const { open } = setup();
    const { bridge } = open();
    await expect(bridge.rpc("bigint")).rejects.toThrow(/not serialisable/);
  });

  test("notify runs the handler and sends no reply frame", async () => {
    const { open, notified } = setup();
    const { bridge, win } = open();
    const shouted = nextEvent(bridge, "shouted");
    bridge.notify("shout", { text: "hi" });
    expect(await shouted).toEqual({ text: "hi" });
    await tick();
    expect(notified).toEqual(["hi"]);
    expect(win.sentToPage.filter((t) => JSON.parse(t).kind === "reply")).toEqual([]);
  });

  test("broadcast events reach every window, targeted events reach one", async () => {
    const { open } = setup();
    const a = open();
    const b = open();
    await a.bridge.rpc("ping");
    await b.bridge.rpc("ping");
    const both = Promise.all([nextEvent(a.bridge, "shouted"), nextEvent(b.bridge, "shouted")]);
    await a.bridge.rpc("shout", { text: "all" });
    expect(await both).toEqual([{ text: "all" }, { text: "all" }]);

    const seenByB: unknown[] = [];
    const offB = b.bridge.on("shouted", (p) => seenByB.push(p));
    const toA = nextEvent(a.bridge, "shouted");
    await a.bridge.rpc("whisper", { text: "just a" });
    expect(await toA).toEqual({ text: "just a" });
    await tick();
    expect(seenByB).toEqual([]);
    offB();
  });

  test("a payload over 1 MB crosses both ways, and as an event", async () => {
    const { open } = setup();
    const { bridge } = open();
    const data = "é".repeat(600_000) + "z".repeat(200_000); // 1.4 MB of UTF-8
    const out = await bridge.rpc("echo", { data });
    expect(out.length).toBe(data.length);
    expect(out.data === data).toBe(true);
    const big = nextEvent(bridge, "big");
    await bridge.rpc("big", { size: 1_500_000 });
    expect((await big).data.length).toBe(1_500_000);
  });

  test("a reload starts a new session and ends the old one; destroying the window ends it", async () => {
    const { open, ended, host } = setup();
    const { win, bridge } = open();
    const first = await bridge.rpc("whoami");
    const api = win.load(); // the page reloads: preload runs again and says hello
    const again = createBridge<Methods, Events>(electronTransport(api));
    const second = await again.rpc("whoami");
    expect(second).not.toBe(first);
    expect(ended).toEqual([first.slice("electron:".length)]);
    win.destroy();
    expect(ended).toEqual([first.slice("electron:".length), second.slice("electron:".length)]);
    expect(host.sessions).toBe(0);
  });

  test("dispose ends every session and stops listening", async () => {
    const { open, ended, host, electron } = setup();
    const { bridge } = open();
    const id = (await bridge.rpc("whoami")).slice("electron:".length);
    host.dispose();
    host.dispose();
    expect(ended).toEqual([id]);
    expect(electron.listenerCount(ELECTRON_CHANNEL)).toBe(0);
  });

  test("allowSender drops frames from refused senders", async () => {
    const service = defineService<Methods, Events>(() => ({ methods: { ping: () => "pong" } as never }));
    const electron = fakeElectron();
    electronHost(service, electron.ipcMain, { allowSender: () => false });
    const win = electron.window();
    const t = electronTransport(win.load());
    let settled = false;
    const call = t.call("ping", null).then(
      () => (settled = true),
      (e: Error) => e.message,
    );
    await tick();
    expect(settled).toBe(false);
    t.dispose();
    expect(await call).toBe("transport disposed");
  });

  test("the page transport needs the preload API and ignores foreign messages", async () => {
    expect(() => electronTransport()).toThrow("not running inside Electron");
    expect(isElectron()).toBe(false);
    const { open } = setup();
    const { win, bridge, transport } = open();
    (globalThis as Record<string, unknown>)[ELECTRON_API_KEY] = win.world[ELECTRON_API_KEY];
    try {
      expect(isElectron()).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>)[ELECTRON_API_KEY];
    }
    win.wc.send(ELECTRON_CHANNEL, "not json");
    win.wc.send(ELECTRON_CHANNEL, "null");
    win.wc.send(ELECTRON_CHANNEL, JSON.stringify({ kind: "reply", seq: "nobody", ok: true, result: 1 }));
    expect(await bridge.rpc("ping")).toBe("pong");
    transport.dispose();
    await expect(transport.call("ping", null)).rejects.toThrow("transport disposed");
  });
});
