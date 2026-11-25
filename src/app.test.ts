// Live Windows tests for WebView.attach, createApp outer-bounds preservation,
// minimum ringBytes validation, and Layer 1 tabbed Window.dispose() cleanup.

import { describe, expect, test } from "bun:test";
import { createApp, WebView } from "./index";
import { Window } from "./native";

const onWindows = process.platform === "win32";

describe.if(onWindows)("WebView & createApp (win32)", () => {
  test("WebView.attach rejects ringBytes below 128 bytes", async () => {
    const win = new Window({ title: "Small Ring", bounds: { x: 100, y: 100, width: 400, height: 300 } });
    try {
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 32 })).rejects.toThrow(/at least 128/);
    } finally {
      win.dispose();
    }
  });

  test("WebView.attach and createApp preserve exact outer bounds on framed windows", async () => {
    const target = { x: 120, y: 120, width: 640, height: 480 };
    const win = new Window({ title: "Attach Bounds", bounds: target });
    const view = await WebView.attach(win, { url: "about:blank" });
    try {
      expect(win.bounds()).toEqual(target);
    } finally {
      view.dispose();
      win.dispose();
    }

    const app = await createApp({ title: "App Bounds", bounds: target, url: "about:blank" });
    try {
      expect(app.window.bounds()).toEqual(target);
    } finally {
      app.dispose();
    }
  });

  test("Layer 1 tabbed Window.dispose() disposes child tab webviews and blocks later openTab calls", async () => {
    const win = new Window({ title: "Layer 1 Tabs", tabs: true, bounds: { x: 140, y: 140, width: 720, height: 500 } });
    const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
    const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
    expect(t1.webview.raw.unsafeHandle).not.toBeNull();
    expect(t2.webview.raw.unsafeHandle).not.toBeNull();

    win.dispose();
    win.dispose(); // idempotent

    expect(t1.webview.raw.unsafeHandle).toBeNull();
    expect(t2.webview.raw.unsafeHandle).toBeNull();
    await expect(WebView.openTab(win, { title: "Three", url: "about:blank" })).rejects.toThrow(/disposed window/);
  });
});
