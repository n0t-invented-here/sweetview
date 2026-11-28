// A window that closes is destroyed, and what it held is given back (decision
// D42): test/fixtures/window-reclaim.ts, in a process of its own with a
// WebView2 profile of its own, keeps a main window open and opens and closes a
// second window with a webview 30 times by each path (a close request with no
// onClose listener, dispose(), createApp's app.dispose(), a tab opened and
// closed in a tabbed window). Afterwards:
//
// - every handle it closed (the window, and the webview container in it)
//   fails IsWindow;
// - the process's USER and GDI objects are back at their value after the
//   warm-up rounds (a count below it passes: another thread may give back its
//   own objects meanwhile), as `assert_gives_back_every_handle` asks of the
//   Rust types;
// - its kernel handles grow by no more than WebView2 and `wry` keep of their
//   own: KERNEL_HANDLES_PER_WINDOW for each new window a webview was made in
//   after the warm-up, none for a tab (measured, below);
// - the WebView2 processes that descend from it are no more than after the
//   warm-up;
// - its private bytes do not climb round over round: the median of the last
//   ten rounds is within PRIVATE_BYTES_NOISE of the median of the first ten
//   after the warm-up.
//
// Nothing here injects input.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Counts = { user: number; gdi: number; handles: number; privateBytes: number; webview2Processes: number };
type PathResult = { path: string; rounds: number; afterWarmUp: Counts; atEnd: Counts; privateBytes: number[]; stillWindows: number; closedHandles: number; roundMs: number[] };

const ROUNDS = 30;
const WARM_UP = 10;
/**
 * Kernel handles kept per window a webview was made in, whoever made it. Measured on Windows 11
 * (26300): 77 over 75 rounds of the close path, 25 over 25 of dispose, and none over 75 rounds of
 * a tab (a webview in a window that stays); `tao` and `wry` alone, with no Sweetview code, keep 6
 * over 5 lives (crates/sweetview-platform-webview/tests/teardown.rs), which is this allowance.
 */
const KERNEL_HANDLES_PER_WINDOW = 1.2;
/**
 * Private bytes move in steps as the allocator takes and gives back segments, up and down: the
 * largest step measured over 80 rounds was 8 MB (the tab path, once), with no climb over the 80
 * rounds; this is one and a half of it.
 */
const PRIVATE_BYTES_NOISE = 12 * 1024 * 1024;

async function runReclaim(): Promise<{ results: PathResult[]; failure?: string; stderr: string; exitCode: number }> {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-reclaim-"));
  try {
    const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/window-reclaim.ts", import.meta.url))], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, SWEETVIEW_RECLAIM_ROUNDS: String(ROUNDS) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const limit = setTimeout(() => process.kill(proc.pid), 280_000);
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(limit);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`no RESULT (exit ${exitCode}): ${stdout}\n${stderr}`);
    return { ...(JSON.parse(line.slice("RESULT ".length)) as { results: PathResult[]; failure?: string }), stderr, exitCode };
  } finally {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
};
/** Private bytes: the median of the last ten rounds less that of the first ten after the warm-up. */
const climb = (values: number[]) => median(values.slice(-10)) - median(values.slice(0, 10));

describe.if(process.platform === "win32")("a closed window gives back what it held (D42)", () => {
  test(
    `${ROUNDS} rounds of each close path`,
    async () => {
      const run = await runReclaim();
      console.log(JSON.stringify(run.results.map(({ path, afterWarmUp, atEnd, stillWindows, closedHandles, privateBytes }) => ({ path, afterWarmUp, atEnd, stillWindows, closedHandles, privateBytesClimb: climb(privateBytes) }))));
      expect(run.failure).toBeUndefined();
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.results.map((r) => r.path)).toEqual(["close", "dispose", "app-dispose", "tab"]);
      for (const r of run.results) {
        const measured = ROUNDS - WARM_UP;
        expect({ path: r.path, stillWindows: r.stillWindows }).toEqual({ path: r.path, stillWindows: 0 });
        // A window and its webview's container, or a tab's container alone.
        expect(r.closedHandles).toBeGreaterThanOrEqual(r.path === "tab" ? ROUNDS : ROUNDS * 2);
        expect({ path: r.path, user: r.atEnd.user <= r.afterWarmUp.user, gdi: r.atEnd.gdi <= r.afterWarmUp.gdi }).toEqual({ path: r.path, user: true, gdi: true });
        expect(r.atEnd.handles - r.afterWarmUp.handles).toBeLessThanOrEqual(r.path === "tab" ? 0 : KERNEL_HANDLES_PER_WINDOW * measured);
        expect(r.atEnd.webview2Processes).toBeLessThanOrEqual(r.afterWarmUp.webview2Processes);
        expect(climb(r.privateBytes)).toBeLessThanOrEqual(PRIVATE_BYTES_NOISE);
      }
    },
    300_000,
  );
});
