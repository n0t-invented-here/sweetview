// Checklist item W3.5: the bindings' examples/input-hooks.ts, brought over
// unchanged as examples/input-hooks.ts (its `../src/index` import names this
// package's index from there too), runs against this package: it starts,
// installs both hooks, shows its window, writes the hooks' events to its page,
// and exits when the window is closed. The window is closed by posting
// WM_CLOSE to it, found by title and process.
//
// The events are read from the example's own page, without touching the
// example: it is started with a preload (test/fixtures/page-reader-preload.ts)
// that gives its webview one more binding and one more user script, through
// which the page reports the text of its `#state` and `#log` on every change;
// the preload prints each report on the example's stdout. (A DevTools port was
// used before; a hosted runner refuses the connection to one.) Injected with
// SendInput: a one-pixel pointer move there and back (the example writes no
// moves), one wheel notch with the cursor over the example's own window (so
// only its page scrolls; the example writes every other mouse event, with its
// position), and F24 pressed and released (bound by no application).

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as probe from "../test/fixtures/win32-probe";

/** What the example's page last reported of itself, read from the preload's lines on its stdout. */
function pageOf(stdout: ReadableStream<Uint8Array>): { text: Record<string, string>; other: string[]; done: Promise<void> } {
  const page = { text: {} as Record<string, string>, other: [] as string[], done: Promise.resolve() };
  page.done = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    const reader = stdout.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      pending += decoder.decode(read.value, { stream: true });
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (line.startsWith("PAGE ")) {
          const report = JSON.parse(line.slice(5)) as { id: string; text: string };
          page.text[report.id] = report.text;
        } else if (line) page.other.push(line);
      }
    }
    if (pending.trim()) page.other.push(pending.trim());
  })();
  return page;
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
  const preload = fileURLToPath(new URL("../test/fixtures/page-reader-preload.ts", import.meta.url));
  const proc = Bun.spawn([process.execPath, "--preload", preload, example], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const page = pageOf(proc.stdout);
  try {
    let hwnd: bigint | null = null;
    for (const deadline = Date.now() + 20_000; hwnd === null && Date.now() < deadline; ) {
      await Bun.sleep(100);
      hwnd = probe.topLevelWindowOf(proc.pid, "Input hooks");
    }
    expect(hwnd).not.toBeNull();
    // Shown, and the page loaded: its state line says the hooks are on.
    for (const deadline = Date.now() + 40_000; !(page.text.state ?? "").startsWith("Hooks on") && Date.now() < deadline; ) await Bun.sleep(100);
    // Why, when it was not read: the page's own line, and whether the example is still there.
    if (!(page.text.state ?? "").startsWith("Hooks on")) {
      throw new Error(`the example's state line was not read as "Hooks on": the page reported ${JSON.stringify(page.text)}; the example ${proc.exitCode === null ? "is running" : `exited ${proc.exitCode}`}`);
    }
    expect(probe.isVisible(hwnd)).toBe(true);
    expect(probe.windowText(hwnd)).toBe("Input hooks");

    // Real input, system-wide: the example's hooks see it and write it to the page. The wheel is
    // turned over the example's own window (the cursor placed there, and put back after), so only
    // its own page scrolls. A round whose events did not all show is injected again, up to five.
    const { cursor, user32, windowRect } = await import("../test/win32-os");
    const original = cursor();
    const frame = windowRect(hwnd!);
    const centre = { x: Math.round((frame.left + frame.right) / 2), y: Math.round((frame.top + frame.bottom) / 2) };
    const log = () => page.text.log ?? "";
    const wanted = (text: string) => /key Down F24 \(raw 135\)/.test(text) && /key Up F24 \(raw 135\)/.test(text) && new RegExp(`mouse Wheel at ${centre.x},${centre.y} wheel 1`).test(text);
    try {
      for (let round = 0; round < 5 && !wanted(log()); round++) {
        user32.SetCursorPos(centre.x, centre.y);
        await mouseMove(1);
        await mouseMove(-1);
        await wheel();
        await f24(false);
        await f24(true);
        for (const deadline = Date.now() + 2000; !wanted(log()) && Date.now() < deadline; ) await Bun.sleep(100);
      }
    } finally {
      user32.SetCursorPos(original.x, original.y);
    }
    console.log(`the example's page log:\n${log().trim()}`);
    expect(log()).toMatch(/key Down F24 \(raw 135\)/);
    expect(log()).toMatch(/key Up F24 \(raw 135\)/);
    expect(log()).toMatch(new RegExp(`mouse Wheel at ${centre.x},${centre.y} wheel 1`));
    // The example writes no move (it skips MouseEvent.Move), so the move shows only as the hook staying quiet about it.
    expect(log()).not.toMatch(/mouse Move/);

    expect(probe.postMessage(hwnd, probe.WM_CLOSE)).toBe(true);
    const exit = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "still running" as const)]);
    if (exit === "still running") proc.kill();
    const [, stderr] = await Promise.all([page.done, new Response(proc.stderr).text()]);
    console.log(`exit: ${exit}\nstdout (without the preload's page reports): ${page.other.join("\n") || "(empty)"}\nstderr: ${stderr.trim() || "(empty)"}`);
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
}, 120_000);
