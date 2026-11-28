// R2: the rows of docs/upgrading.md whose change is more than a new name or a
// new import, run for real. upgrade-guide.test.ts checks every row's shape;
// this file runs what the rows say behaves differently. Tests that make a
// window or a webview run in a child process (fixtures/) with a fresh
// WebView2 profile folder, and exit by themselves.

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      wrapKeepsSize: true,
      windowHandleType: "number",
      windowBoundsPositive: true,
      bindRaw: { same: true, req: '[1,"two"]' },
      handleAfterDestroy: null,
      completeAfterDestroy: "WebviewError webview_complete_request -3",
      windowHandleAfterDestroy: null,
      setRequestHandlerAfterDestroy: "WebviewError webview_set_request_handler -3",
      destroyTwice: "no error",
    });
  }, 120_000);

  test("what the deleted win32 init, message-window and icon modules did: DPI awareness and an STA from the binding, a hidden Window as owner, setIcon on a wrapper", async () => {
    expect(await runChild(fixture("own-window.ts"))).toEqual({
      perMonitorAware: true,
      uiThreadIsSta: true,
      ownerHidden: true,
      ownerOnAScreen: true,
      iconSet: true,
      iconBackToStock: true,
    });
  }, 60_000);

  test("tabs: the frame is a Window with tabs, getTabFrame gives its strip and page, close requests reach onClose, the tab menus act on any window of the thread, tab.webview.window wraps the frame", async () => {
    expect(await runChild(fixture("tabs.ts"))).toEqual({
      frameOfTabbedWindow: true,
      frameOfPlainWindow: true,
      stripBoundsPositive: true,
      pageBelowStrip: true,
      stripRectOnScreen: true,
      pageSizePositive: true,
      childInFrame: true,
      popupOnPlainWindow: true,
      popupClickRan: true,
      popupWithNoItems: false,
      windowMenuOnPlainWindow: [false, true, true, true, true, "-", true],
      requestCloseReachesOnClose: true,
      windowKeptByListener: true,
      tabWindowIsLogical: true,
      tabWebviewWindowWrapsFrame: true,
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
      expect(report).toEqual({ boundsPositive: true, onClose: refused, onResize: refused, onMaximizeChange: refused, onMove: refused, onFileDrop: refused });
    } finally {
      holder.stdin.end();
      const exited = await Promise.race([holder.exited, Bun.sleep(10_000).then(() => "timeout")]);
      if (exited === "timeout") holder.kill();
    }
  }, 120_000);

  test("a close request disposes a Window with no onClose listener (and ends createApp's run()); onClose: () => win.hide() keeps it, as createOverlayWindow's window did", async () => {
    expect(await runChild(fixture("close-request.ts"))).toEqual({
      windowWithoutListener: { disposed: true, osWindowExists: false },
      windowWithHide: { disposed: false, osWindowExists: true, visible: false },
      appWithHide: { disposed: false, osWindowExists: true, visible: false, webviewAlive: true },
      appWithoutListener: { runReturned: true, disposed: true, osWindowExists: false },
    });
  }, 120_000);

  test("width and height: bounds is the outer frame; RawWebview#size sets the client size in DIPs on createApp's own window, as 0.x did", async () => {
    expect(await runChild(fixture("client-size.ts"))).toEqual({
      framedBoundsAreOuter: true,
      sizeNoneSetsClientDips: true,
      sizeNoneKeepsResizable: true,
      sizeKeepsTopLeft: true,
      sizeDoesNotShow: true,
      pageFillsClient: true,
      sizeFixedSetsClientDips: true,
      sizeFixedNotResizable: true,
      framelessClientIsBounds: true,
    });
  }, 120_000);

  test("popupMenuAtCursor opens the menu upward from the cursor; Menu.popup and popupMenu open it downward from the point, and Menu.popup with { above: true } upward", async () => {
    expect(await runChild(fixture("popup-direction.ts"))).toEqual({
      atCursorAsks: { at: null, above: true },
      menuPopupAtCursorAsks: { at: null, above: false },
      menuPopupAtPointAsks: true,
      popupMenuAtPointAsks: true,
      menuPopupAboveAtCursorAsks: { at: null, above: true },
      menuPopupAboveAtPointAsks: true,
      aboveOpensUpward: true,
      menuPopupOpensDownward: true,
      menuPopupAboveOpensUpward: true,
    });
  }, 60_000);

  test("a Notifier needs no tray; with no appId or identity it is Sweetview's toast identity, with identity the application's own", async () => {
    expect(await runChild(fixture("notifier-identity.ts"))).toEqual({
      withoutTrayOrIdentity: { appId: null, appName: null },
      withIdentity: true,
      registeredUnderOwnName: true,
      registryCleaned: true,
    });
  }, 60_000);

  test("SWEETVIEW_NATIVE_PATH names the binding the loader uses", async () => {
    const custom = join(tempDir("binding"), "custom-build.node");
    copyFileSync(join(root, "packages", "sweetview-native", "prebuilt", "sweetview.win32-x64-msvc.node"), custom);
    expect(await runChild(fixture("native-path.ts"), [], { SWEETVIEW_NATIVE_PATH: custom })).toEqual({ ok: true });
    const missing = join(tempDir("binding"), "missing.node");
    const failed = await runChild(fixture("native-path.ts"), [], { SWEETVIEW_NATIVE_PATH: missing });
    expect(String(failed.error)).toStartWith(`sweetview: the native binding could not be loaded from ${missing} (SWEETVIEW_NATIVE_PATH): `);
  }, 60_000);

  // "What changed for every application", the macOS engine: with @n1h/sweetview-webview-bun installed
  // (this workspace has it, for macOS), a compile for Windows bundles none of it, and one for macOS
  // bundles its sources and its native library. The bundled inputs are read from the metafile.
  test("a Windows executable leaves the installed macOS engine out; a macOS one keeps it", () => {
    const dir = tempDir("engine");
    const inputs = (target: string) => {
      const meta = join(dir, `${target}.json`);
      const built = Bun.spawnSync([process.execPath, "build", "--compile", `--target=${target}`, "--minify", `--metafile=${meta}`, "app.ts", "--outfile", join(dir, target)], {
        cwd: join(root, "demos", "menubar-only"),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      expect({ target, exit: built.exitCode, stderr: built.exitCode === 0 ? "" : built.stderr.toString() }).toEqual({ target, exit: 0, stderr: "" });
      return Object.keys(JSON.parse(readFileSync(meta, "utf8")).inputs as Record<string, unknown>)
        .filter((input) => input.includes("sweetview-webview-bun"))
        .map((input) => input.replace(/^.*sweetview-webview-bun\//, ""))
        .sort();
    };
    expect(inputs("bun-windows-x64")).toEqual([]);
    expect(inputs("bun-darwin-arm64")).toEqual(["build/libwebview.dylib", "src/ffi.ts", "src/index.ts", "src/input-hooks.ts", "src/keyboard-hook.ts", "src/mouse-hook.ts", "src/permissions.ts", "src/webview.ts"]);
  }, 300_000);
});

// Part A, "Scripts run by path" and the subpaths of `@n1h/sweetview-native`: what an installed
// application can reach. The packages are packed as they would be published and installed into an
// application that depends on `@n1h/sweetview` alone, then on the two packages as well, with Bun's
// isolated linker (each project's node_modules holds only what it names) and its hoisted one.
describe("what an installed application reaches by path", () => {
  const SCRIPT = "node_modules/@n1h/sweetview-build/src/make-app.ts";
  const PROBE = `const reach = (s) => { try { Bun.resolveSync(s, process.cwd()); return true; } catch { return false; } };
const fs = require("node:fs");
console.log(JSON.stringify({
  makeApp: fs.existsSync("${SCRIPT}"),
  refreshIcons: fs.existsSync("node_modules/@n1h/sweetview-build/src/refresh-icons.ts"),
  makeAppInSweetview: fs.existsSync("node_modules/@n1h/sweetview/src/make-app.ts"),
  nativeSubpath: reach("@n1h/sweetview-native/win32/menu"),
  facade: reach("@n1h/sweetview/native"),
}));`;

  test("make-app.ts is in @n1h/sweetview-build; with isolated installs it and @n1h/sweetview-native/... resolve only when the application depends on those packages itself", () => {
    const dir = tempDir("install");
    const tgz = join(dir, "tgz");
    const names = ["sweetview", "sweetview-native", "sweetview-build", "sweetview-settings", "sweetview-ipc", "sweetview-ipc-ws", "sweetview-ipc-electron", "sweetview-ipc-tauri"];
    const tarball = new Map<string, string>();
    for (const name of names) {
      const pkg = join(root, "packages", name);
      const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", tgz, "--quiet"], { cwd: pkg, stdout: "pipe", stderr: "pipe" });
      expect({ name, exit: packed.exitCode }).toEqual({ name, exit: 0 });
      const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version as string;
      tarball.set(`@n1h/${name}`, `file:${join(tgz, `n1h-${name}-${version}.tgz`).replaceAll("\\", "/")}`);
    }
    const install = (label: string, linker: "isolated" | "hoisted", direct: string[]) => {
      const app = join(dir, label);
      mkdirSync(app, { recursive: true });
      const dependencies = Object.fromEntries(["@n1h/sweetview", ...direct].map((name) => [name, tarball.get(name)!]));
      writeFileSync(join(app, "package.json"), JSON.stringify({ name: "upgrade-probe", private: true, type: "module", dependencies, overrides: Object.fromEntries(tarball) }));
      writeFileSync(join(app, "probe.js"), PROBE);
      const installed = Bun.spawnSync([process.execPath, "install", "--linker", linker], { cwd: app, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
      expect({ label, exit: installed.exitCode, stderr: installed.exitCode === 0 ? "" : installed.stderr.toString() }).toEqual({ label, exit: 0, stderr: "" });
      const probe = Bun.spawnSync([process.execPath, "probe.js"], { cwd: app, stdout: "pipe", stderr: "pipe" });
      const script = Bun.spawnSync([process.execPath, SCRIPT, "--help"], { cwd: app, stdout: "pipe", stderr: "pipe" });
      return { ...JSON.parse(probe.stdout.toString().trim()), makeAppRuns: script.exitCode === 0 && script.stdout.toString().startsWith("usage:") };
    };
    const none = { makeApp: false, refreshIcons: false, makeAppInSweetview: false, nativeSubpath: false, facade: true, makeAppRuns: false };
    const both = { makeApp: true, refreshIcons: true, makeAppInSweetview: false, nativeSubpath: true, facade: true, makeAppRuns: true };
    expect(install("isolated-sweetview-only", "isolated", [])).toEqual(none);
    expect(install("isolated-with-both", "isolated", ["@n1h/sweetview-build", "@n1h/sweetview-native"])).toEqual(both);
    expect(install("hoisted-sweetview-only", "hoisted", [])).toEqual(both);
  }, 180_000);
});
