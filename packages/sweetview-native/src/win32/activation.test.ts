// Live Windows FFI tests for custom URL scheme registration (HKCU),
// two-process singleInstance (CreateMutexW + HWND_MESSAGE + WM_COPYDATA),
// and activation URL buffering -> signalReady() drain.

import { afterEach, describe, expect, test } from "bun:test";
import { ptr } from "bun:ffi";
import {
  _resetActivationForTest,
  emitActivationUrl,
  extractUrlFromArgs,
  onOpenUrl,
  registerUrlScheme,
  signalReady,
  singleInstance,
  unregisterUrlScheme,
  type SecondInstanceEvent,
} from "../activation";
import { pumpEvents } from "../event-loop";

const onWindows = process.platform === "win32";

afterEach(() => {
  _resetActivationForTest();
});

describe("activation URL buffering & extraction", () => {
  test("extractUrlFromArgs matches declared schemes or custom non-web schemes", () => {
    expect(extractUrlFromArgs(["--flag", "my-app://open/123"], ["my-app"])).toBe("my-app://open/123");
    expect(extractUrlFromArgs(["https://example.com", "other://foo"], ["my-app"])).toBeUndefined();
    expect(extractUrlFromArgs(["https://example.com", "custom-proto://x"])).toBe("custom-proto://x");
  });

  test("buffers early URLs until signalReady() and then drains in FIFO order", () => {
    const seen: string[] = [];
    const off = onOpenUrl((url) => seen.push(url));
    emitActivationUrl("my-app://first");
    emitActivationUrl("my-app://second");
    expect(seen).toEqual([]);

    signalReady();
    expect(seen).toEqual(["my-app://first", "my-app://second"]);

    emitActivationUrl("my-app://third");
    expect(seen).toEqual(["my-app://first", "my-app://second", "my-app://third"]);
    off();
  });
});

describe.if(onWindows)("win32 URL schemes & single-instance", () => {
  test("registerUrlScheme writes HKCU keys and unregisterUrlScheme removes them cleanly", async () => {
    const { advapi32, HKEY_CURRENT_USER, wstr } = await import("./api");
    const scheme = `sweetview-test-${process.pid}-${Date.now()}`;
    const RRF_RT_REG_SZ = 0x00000002;
    const readReg = (subKey: string, value: string | null): string | null => {
      const lenBuf = new Uint32Array([4096]);
      const dataBuf = new Uint8Array(4096);
      const st = advapi32.RegGetValueW(
        HKEY_CURRENT_USER,
        wstr(subKey),
        value === null ? null : wstr(value),
        RRF_RT_REG_SZ,
        null,
        ptr(dataBuf),
        ptr(lenBuf),
      );
      if (st !== 0) return null;
      return Buffer.from(dataBuf.subarray(0, Math.max(0, lenBuf[0]! - 2))).toString("utf16le");
    };

    try {
      registerUrlScheme(scheme, {
        appName: "Sweetview Test",
        executablePath: "C:\\SweetviewTest\\app.exe",
      });
      expect(readReg(`Software\\Classes\\${scheme}`, null)).toBe("URL:Sweetview Test Protocol");
      expect(readReg(`Software\\Classes\\${scheme}`, "URL Protocol")).toBe("");
      expect(readReg(`Software\\Classes\\${scheme}\\DefaultIcon`, null)).toBe("C:\\SweetviewTest\\app.exe,0");
      expect(readReg(`Software\\Classes\\${scheme}\\shell\\open\\command`, null)).toBe('"C:\\SweetviewTest\\app.exe" "%1"');
    } finally {
      unregisterUrlScheme(scheme);
    }
    expect(readReg(`Software\\Classes\\${scheme}`, null)).toBeNull();
    // Unregistering a missing scheme is a safe no-op
    expect(() => unregisterUrlScheme(scheme)).not.toThrow();
    // Invalid scheme rejected
    expect(() => registerUrlScheme("123bad scheme!")).toThrow(/invalid URL scheme/);
  });

  test("singleInstance retries when the mutex exists before its message window is discoverable", async () => {
    const { HWND_MESSAGE, user32, wstr } = await import("./api");
    const appId = `dev.sweetview.test.race-${process.pid}-${Date.now()}`;
    const title = wstr(`sweetview.instance.${appId}`);
    const windowClass = wstr("SweetviewSingleInstanceWindow");
    const received: SecondInstanceEvent[] = [];
    const primary = await singleInstance({ appId, args: [], onSecondInstance: (event) => received.push(event) });
    try {
      const hwnd = user32.FindWindowExW(HWND_MESSAGE, 0n, windowClass, title);
      expect(hwnd).not.toBe(0n);
      user32.SetWindowTextW(hwnd, wstr("not yet discoverable"));
      expect(user32.FindWindowExW(HWND_MESSAGE, 0n, windowClass, title)).toBe(0n);
      const pending = singleInstance({ appId, args: ["--raced"] });
      user32.SetWindowTextW(hwnd, title);
      const secondary = await pending;
      secondary.dispose();
      expect(secondary.isPrimary).toBe(false);
      expect(secondary.handedOff).toBe(true);
      expect(received[0]?.args).toEqual(["--raced"]);
    } finally {
      primary.dispose();
    }
  });

  test("singleInstance hands off args and URL from a real secondary process via WM_COPYDATA", async () => {
    const appId = `dev.sweetview.test.single-${process.pid}-${Date.now()}`;
    const received: SecondInstanceEvent[] = [];
    const openedUrls: string[] = [];

    onOpenUrl((u) => openedUrls.push(u));
    const lock = await singleInstance({
      appId,
      urlSchemes: ["svtest"],
      args: ["svtest://cold/start"],
      onSecondInstance: (evt) => received.push(evt),
    });

    try {
      expect(lock.isPrimary).toBe(true);
      expect(lock.handedOff).toBe(false);
      // Cold-launch URL is buffered until signalReady()
      expect(openedUrls).toEqual([]);
      signalReady();
      expect(openedUrls).toEqual(["svtest://cold/start"]);

      // Spawn a real secondary Bun process targeting the same appId
      const childScript = `
        import { singleInstance } from "@n1h/sweetview-native";
        const lock = await singleInstance({
          appId: ${JSON.stringify(appId)},
          urlSchemes: ["svtest"],
          args: ["--extra", "svtest://warm/42"],
        });
        console.log(JSON.stringify({ isPrimary: lock.isPrimary, handedOff: lock.handedOff }));
        lock.dispose();
      `;
      const child = Bun.spawn([process.execPath, "-e", childScript], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });

      // Pump primary thread's Win32 message queue while the child sends WM_COPYDATA
      const deadline = Date.now() + 5000;
      let childDone = false;
      void child.exited.then(() => (childDone = true));
      while (!childDone && Date.now() < deadline) {
        pumpEvents();
        await Bun.sleep(10);
      }
      pumpEvents();

      const exitCode = await child.exited;
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ isPrimary: false, handedOff: true });

      expect(received).toHaveLength(1);
      expect(received[0]!.url).toBe("svtest://warm/42");
      expect(received[0]!.args).toEqual(["--extra", "svtest://warm/42"]);
      expect(openedUrls).toEqual(["svtest://cold/start", "svtest://warm/42"]);
    } finally {
      lock.dispose();
      lock.dispose(); // idempotent
    }
  });
});
