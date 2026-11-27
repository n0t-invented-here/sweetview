// R2: the rows of docs/upgrading.md whose change is more than a new name or a
// new import, run for real. upgrade-guide.test.ts checks every row's shape;
// this file runs what the rows say behaves differently. Tests that make a
// window or a webview run in a child process (fixtures/) with a fresh
// WebView2 profile folder, and exit by themselves.

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SizeHint as RootSizeHint, windowChromeMethods } from "@n1h/sweetview";
import { wsHost } from "@n1h/sweetview/ipc-ws";
import { defineService } from "@n1h/sweetview/ipc";
import { Feature, KeyEvent, Modifier, MouseEvent, Permission, SizeHint, Window, dotIco, setAppMenu, unload } from "@n1h/sweetview-native";

const root = join(import.meta.dir, "..", "..");
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const onWindows = process.platform === "win32";
const temps: string[] = [];
const tempDir = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `sweetview-compat-${label}-`));
  temps.push(dir);
  return dir;
};
afterAll(async () => {
  // The WebView2 browser process can hold its profile for a few seconds after the child exits.
  for (const dir of temps) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 120) {
          console.warn(`sweetview compat: could not delete ${dir}: ${(err as Error).message}`);
          break;
        }
        await Bun.sleep(250);
      }
    }
  }
}, 60_000);

async function runChild(file: string, args: string[] = [], env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, file, ...args], {
    cwd: root,
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: tempDir("profile"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 90_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const last = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  if (exit !== 0 || !last.startsWith("{")) throw new Error(`${file} exited ${exit}\n${stdout}\n${stderr}`);
  return JSON.parse(last);
}

describe("enums that were const enums are values", () => {
  test("their members exist at run time, with reverse names", () => {
    expect(SizeHint[3]).toBe("FIXED");
    expect([SizeHint.NONE, SizeHint.MIN, SizeHint.MAX, SizeHint.FIXED]).toEqual([0, 1, 2, 3]);
    expect(RootSizeHint).toBe(SizeHint);
    expect(Object.values(MouseEvent).filter((v) => typeof v === "number")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(MouseEvent[7]).toBe("Wheel");
    expect([KeyEvent.Down, KeyEvent.Up, KeyEvent.Repeat]).toEqual([0, 1, 2]);
    expect([Modifier.Shift, Modifier.Control, Modifier.Alt, Modifier.Meta]).toEqual([1, 2, 4, 8]);
    expect([Feature.MouseHook, Feature.KeyboardHook]).toEqual([0, 1]);
    expect([Permission.DeviceControl, Permission.InputMonitoring]).toEqual([1, 2]);
  });
});

describe("renamed options and members (0.x)", () => {
  test("windowChromeMethods takes onClose (it was close)", () => {
    const calls: string[] = [];
    const window = {
      hide: () => calls.push("hide"),
      isMaximized: () => false,
      startDrag: () => calls.push("drag"),
      startResize: () => calls.push("resize"),
      minimize: () => calls.push("minimize"),
      toggleMaximize: () => calls.push("maximize"),
    };
    const methods = windowChromeMethods(window, { onClose: () => calls.push("onClose") });
    methods["window.close"]();
    expect(methods["window.info"]()).toEqual({ chrome: "page", maximized: false });
    expect(calls).toEqual(["onClose"]);
    windowChromeMethods(window)["window.close"]();
    expect(calls).toEqual(["onClose", "hide"]);
  });

  test("a WebSocket host is disposed with dispose() (it was close())", () => {
    const service = defineService(() => ({ methods: {} }));
    const host = wsHost(service);
    expect(typeof host.dispose).toBe("function");
    host.dispose();
    expect(host.sessions).toBe(0);
  });

  test("dotIcon is dotIco and writes an .ico", () => {
    const ico = dotIco();
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  });

  test.skipIf(!onWindows)("installAppMenu is setAppMenu", () => {
    expect(() => setAppMenu({ appName: "compat", aboutText: "compat" })).not.toThrow();
  });

  test("unload() with no live webview does nothing", () => {
    expect(() => unload()).not.toThrow();
  });
});

describe.skipIf(!onWindows)("Windows behaviour an application notices", () => {
  test("Window.fromHandle of a handle that names no window throws", () => {
    expect(() => Window.fromHandle(0x1234n)).toThrow("sweetview: not a window: 0x1234");
    expect(() => Window.fromHandle(null)).toThrow("sweetview: window handle is NULL");
  });

  test("Webview: the opaque unsafeHandle, the real HWND, bindRaw's value; WEBVIEW_PATH has no effect", async () => {
    const report = await runChild(fixture("webview.ts"), [], { WEBVIEW_PATH: join(tempDir("no-library"), "webview.dll") });
    expect(report).toMatchObject({
      handleType: "number",
      handleIsSafeInteger: true,
      completeUnknownRequest: "no error",
      endUnknownResponse: "no error",
      completeOnUnknownHandle: "WebviewError webview_complete_request -3",
      wrapUnknownHandle: "WebviewError webview_create -1",
      wrapSameHandle: true,
      windowHandleType: "number",
      windowBoundsPositive: true,
      bindRaw: { same: true, req: '[1,"two"]' },
      handleAfterDestroy: null,
      completeAfterDestroy: "WebviewError webview_complete_request -3",
    });
  }, 120_000);

  test("an overlay made with createApp; Window, Screen, HitRelay; Clipboard from a Worker throws", async () => {
    const report = await runChild(fixture("app.ts"));
    expect(report).toEqual({
      windowIsWindow: true,
      windowHandleType: "bigint",
      rawHandleType: "number",
      notify: "function",
      boundsKept: true,
      isMaximized: false,
      scalePositive: true,
      wrappedFrame: false,
      onCloseReturns: "function",
      screen: { cursor: true, primary: true, workArea: true, at: true, virtual: true, of: true },
      hitRelay: { isClass: true, isEnabled: false },
      workerClipboard: "sweetview: this call must be made on the UI thread",
    });
  }, 120_000);

  test("events on a wrapper of another thread's window throw", async () => {
    const holder = Bun.spawn([process.execPath, fixture("foreign-window.ts"), "hold"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      let text = "";
      while (!/\r?\n/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      const handle = text.trim().split(/\r?\n/)[0]!;
      expect(handle).toMatch(/^\d+$/);
      const report = await runChild(fixture("foreign-window.ts"), ["observe", handle]);
      const refused = "sweetview: a window of another thread cannot be observed";
      expect(report).toEqual({ boundsPositive: true, onClose: refused, onResize: refused, onMove: refused, onFileDrop: refused });
    } finally {
      holder.stdin.end();
      const exited = await Promise.race([holder.exited, Bun.sleep(10_000).then(() => "timeout")]);
      if (exited === "timeout") holder.kill();
    }
  }, 120_000);

  test("SWEETVIEW_NATIVE_PATH names the binding the loader uses", async () => {
    const custom = join(tempDir("binding"), "custom-build.node");
    copyFileSync(join(root, "packages", "sweetview-native", "prebuilt", "sweetview.win32-x64-msvc.node"), custom);
    expect(await runChild(fixture("native-path.ts"), [], { SWEETVIEW_NATIVE_PATH: custom })).toEqual({ ok: true });
    const missing = join(tempDir("binding"), "missing.node");
    const failed = await runChild(fixture("native-path.ts"), [], { SWEETVIEW_NATIVE_PATH: missing });
    expect(String(failed.error)).toStartWith(`sweetview: the native binding could not be loaded from ${missing} (SWEETVIEW_NATIVE_PATH): `);
  }, 60_000);
});
