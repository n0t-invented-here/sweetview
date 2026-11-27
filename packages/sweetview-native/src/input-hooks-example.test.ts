// Checklist item W3.5: the bindings' examples/input-hooks.ts, brought over
// unchanged as examples/input-hooks.ts (its `../src/index` import names this
// package's index from there too), runs against this package: it starts,
// installs both hooks, shows its window, writes the hooks' events to its page,
// and exits when the window is closed. The window is closed by posting
// WM_CLOSE to it, found by title and process.
//
// The events are read from the example's own page, without touching the
// example: its WebView2 is started with a DevTools port of its own
// (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, which WebView2 reads itself), and the
// page's `#log` is read over the DevTools protocol. Injected with SendInput: a
// one-pixel pointer move there and back (the example writes no moves), one
// wheel notch with the cursor over the example's own window (so only its page
// scrolls; the example writes every other mouse event, with its position), and
// F24 pressed and released (bound by no application).

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as probe from "../test/fixtures/win32-probe";

/** A TCP port free right now on the loopback interface. */
function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Evaluates `expression` in the page target of the WebView2 listening on `port`; its value as a string. */
async function evaluateInPage(port: number, expression: string): Promise<string> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`no page target: ${JSON.stringify(targets)}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("the DevTools socket did not open"));
    });
    const answer = new Promise<string>((resolve) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) resolve(String(message.result?.result?.value ?? ""));
      };
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    return await Promise.race([answer, Bun.sleep(5000).then(() => "")]);
  } finally {
    socket.close();
  }
}

/** SendInput of one INPUT (x64: 40 bytes) filled by `fill`. */
async function inject(fill: (view: DataView) => void): Promise<void> {
  const { user32 } = await import("../test/win32-os");
  const input = new Uint8Array(40);
  fill(new DataView(input.buffer));
  user32.SendInput(1, input, 40);
}
const mouseMove = (dx: number) =>
  inject((v) => {
    v.setUint32(0, 0, true); // INPUT_MOUSE
    v.setInt32(8, dx, true);
    v.setUint32(20, 0x0001, true); // MOUSEEVENTF_MOVE
  });
const wheel = () =>
  inject((v) => {
    v.setUint32(0, 0, true);
    v.setInt32(16, 120, true); // mouseData: one notch (WHEEL_DELTA)
    v.setUint32(20, 0x0800, true); // MOUSEEVENTF_WHEEL
  });
const f24 = (up: boolean) =>
  inject((v) => {
    v.setUint32(0, 1, true); // INPUT_KEYBOARD
    v.setUint16(8, 0x87, true); // VK_F24
    v.setUint32(12, up ? 0x0002 : 0, true);
  });

test.if(process.platform === "win32")("W3.5 examples/input-hooks.ts starts, shows its window, writes injected hook events to its page and exits when the window is closed", async () => {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-example-"));
  const example = fileURLToPath(new URL("../examples/input-hooks.ts", import.meta.url));
  const port = freePort();
  const proc = Bun.spawn([process.execPath, example], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let hwnd: bigint | null = null;
    for (const deadline = Date.now() + 20_000; hwnd === null && Date.now() < deadline; ) {
      await Bun.sleep(100);
      hwnd = probe.topLevelWindowOf(proc.pid, "Input hooks");
    }
    expect(hwnd).not.toBeNull();
    // Shown, and the page loaded: its state line says the hooks are on.
    let state = "";
    for (const deadline = Date.now() + 20_000; !state.startsWith("Hooks on") && Date.now() < deadline; await Bun.sleep(200)) {
      state = await evaluateInPage(port, `document.getElementById("state")?.textContent ?? ""`).catch(() => "");
    }
    expect(state.startsWith("Hooks on")).toBe(true);
    expect(probe.isVisible(hwnd)).toBe(true);
    expect(probe.windowText(hwnd)).toBe("Input hooks");

    // Real input, system-wide: the example's hooks see it and write it to the page. The wheel is
    // turned over the example's own window (the cursor placed there, and put back after), so only
    // its own page scrolls. A round whose events did not all show is injected again, up to five.
    const { cursor, user32, windowRect } = await import("../test/win32-os");
    const original = cursor();
    const frame = windowRect(hwnd!);
    const centre = { x: Math.round((frame.left + frame.right) / 2), y: Math.round((frame.top + frame.bottom) / 2) };
    let log = "";
    const wanted = (text: string) => /key Down F24 \(raw 135\)/.test(text) && /key Up F24 \(raw 135\)/.test(text) && new RegExp(`mouse Wheel at ${centre.x},${centre.y} wheel 1`).test(text);
    try {
      for (let round = 0; round < 5 && !wanted(log); round++) {
        user32.SetCursorPos(centre.x, centre.y);
        await mouseMove(1);
        await mouseMove(-1);
        await wheel();
        await f24(false);
        await f24(true);
        for (const deadline = Date.now() + 2000; !wanted(log) && Date.now() < deadline; await Bun.sleep(200)) {
          log = await evaluateInPage(port, `document.getElementById("log").textContent`);
        }
      }
    } finally {
      user32.SetCursorPos(original.x, original.y);
    }
    console.log(`the example's page log:\n${log.trim()}`);
    expect(log).toMatch(/key Down F24 \(raw 135\)/);
    expect(log).toMatch(/key Up F24 \(raw 135\)/);
    expect(log).toMatch(new RegExp(`mouse Wheel at ${centre.x},${centre.y} wheel 1`));
    // The example writes no move (it skips MouseEvent.Move), so the move shows only as the hook staying quiet about it.
    expect(log).not.toMatch(/mouse Move/);

    expect(probe.postMessage(hwnd, probe.WM_CLOSE)).toBe(true);
    const exit = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "still running" as const)]);
    if (exit === "still running") proc.kill();
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    console.log(`exit: ${exit}\nstdout: ${stdout.trim() || "(empty)"}\nstderr: ${stderr.trim() || "(empty)"}`);
    expect(exit).toBe(0);
    // The hooks installed: the example logs a warning when they do not.
    expect(stderr).not.toContain("input hooks off");
    expect(probe.isWindow(hwnd)).toBe(false);
  } finally {
    if (proc.exitCode === null) proc.kill();
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
}, 90_000);
