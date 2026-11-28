// The window-chrome module's two halves with stand-ins for the window, the
// webview and the page's transport: no window, webview or input.

import { describe, expect, test } from "bun:test";
import type { Transport } from "@n1h/sweetview-ipc";
import { windowChromeControls, windowChromeEvents, windowChromeMethods, type WindowChromeEvents } from "./window-chrome";

/** A window stand-in whose maximise listeners the test drives. */
function fakeWindow() {
  const listeners = new Set<(maximized: boolean) => void>();
  const calls: string[] = [];
  return {
    calls,
    listeners,
    change: (maximized: boolean) => [...listeners].forEach((fn) => fn(maximized)),
    window: {
      hide: () => calls.push("hide"),
      isMaximized: () => false,
      startDrag: () => calls.push("drag"),
      startResize: () => calls.push("resize"),
      minimize: () => calls.push("minimize"),
      toggleMaximize: () => calls.push("maximize"),
      showSystemMenu: () => calls.push("systemMenu"),
      onMaximizeChange: (fn: (maximized: boolean) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
}

/** A transport stand-in: what the page sent, and a way to deliver events to it. */
function fakeTransport() {
  const sent: [string, unknown][] = [];
  const handlers = new Set<(name: string, payload: unknown) => void>();
  const transport: Transport = {
    kind: "webview",
    call: async (method, params) => {
      sent.push([method, params]);
      return { chrome: "page", maximized: false };
    },
    notify: (method, params) => void sent.push([method, params]),
    onEvent: (fn) => {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
  };
  return { sent, transport, deliver: (name: string, payload: unknown) => [...handlers].forEach((fn) => fn(name, payload)) };
}

describe("window chrome", () => {
  test("windowChromeEvents sends window.maximized with each change until stopped", () => {
    const { window, change, listeners } = fakeWindow();
    const emitted: [string, unknown][] = [];
    const stop = windowChromeEvents(window, { emit: (name, payload) => void emitted.push([name, payload]) });
    change(true);
    change(false);
    expect(emitted).toEqual([
      ["window.maximized", { maximized: true }],
      ["window.maximized", { maximized: false }],
    ]);
    stop();
    expect(listeners.size).toBe(0);
    change(true);
    expect(emitted.length).toBe(2);
  });

  test("the page's onMaximizeChange gets window.maximized and nothing else, until it stops", () => {
    const { transport, deliver } = fakeTransport();
    const seen: boolean[] = [];
    const stop = windowChromeControls(transport).onMaximizeChange((maximized) => seen.push(maximized));
    const event: WindowChromeEvents["window.maximized"] = { maximized: true };
    deliver("window.maximized", event);
    deliver("something.else", { maximized: false });
    deliver("window.maximized", { maximized: false });
    stop();
    deliver("window.maximized", { maximized: true });
    expect(seen).toEqual([true, false]);
  });

  // macOS keeps the tag's table, which has no window.systemMenu.
  test.if(process.platform !== "darwin")("window.systemMenu shows the window's system menu; a window without one is fine", () => {
    const { window, calls } = fakeWindow();
    windowChromeMethods(window)["window.systemMenu"]!();
    expect(calls).toEqual(["systemMenu"]);
    const { showSystemMenu: _, ...withoutMenu } = window;
    expect(() => windowChromeMethods(withoutMenu)["window.systemMenu"]!()).not.toThrow();
    const { sent, transport } = fakeTransport();
    windowChromeControls(transport).showSystemMenu();
    expect(sent).toEqual([["window.systemMenu", null]]);
  });
});
