// A window is never seen with its webview gone and its client area empty, and
// what shows where no page is painted is the window's backdrop, not white
// (decision D46). Each test runs test/fixtures/quit-flash.ts in a process of
// its own, with a WebView2 profile of its own, and test/fixtures/window-watch.ts
// in a second process, started before the window appears, which samples the
// screen as fast as it can read it until the fixture has exited:
//
// - quitting (from inside the blocking run(), under the pumped loop, by
//   app.dispose() or the window's dispose inside run(), and two runs one after
//   the other): from the sample in which its webview is gone, the window is
//   never on the screen, and no sample shows it light and flat;
// - a webview replaced in a window that stays, and the last tab of a tabbed
//   window disposed while the window stays: while no page covers it, the
//   window shows its backdrop (dark, for appearance "dark"), never white.
//
// Nothing here injects input.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onScreen, summarize, type Sample, type WindowSummary } from "../test/fixtures/window-watch";

const LIVE_TEST_MS = 60_000;
/** The backdrop of a dark window (#15161a) as the watcher reads it, to 3 bits per channel less. */
const DARK_BACKDROP: [number, number, number] = [0x10, 0x10, 0x18];
/** The fixture's page colour (#1f2a33), read the same way. */
const PAGE: [number, number, number] = [0x18, 0x28, 0x30];
const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

type Watched = { exitCode: number | null; stdout: string; stderr: string; samples: Sample[]; summary: WindowSummary | undefined; hwnd: string | undefined };

async function watchFixture(mode: string): Promise<Watched> {
  const scratch = mkdtempSync(join(tmpdir(), "sweetview-quit-flash-"));
  const profile = join(scratch, "profile");
  const out = join(scratch, "samples.jsonl");
  try {
    const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/quit-flash.ts", import.meta.url))], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, SWEETVIEW_FLASH_TEST: mode },
      stdout: "pipe",
      stderr: "pipe",
    });
    const watcher = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/window-watch.ts", import.meta.url)), String(proc.pid), out, "40000"], { stdout: "pipe", stderr: "pipe" });
    let killed = false;
    const limit = setTimeout(() => {
      killed = true;
      process.kill(proc.pid);
    }, 40_000);
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(limit);
    const [watcherOut, watcherErr] = await Promise.all([new Response(watcher.stdout).text(), new Response(watcher.stderr).text(), watcher.exited]);
    if (!watcherOut.includes("DONE")) throw new Error(`the watcher failed: ${watcherOut} ${watcherErr}`);
    const samples = readFileSync(out, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Sample);
    const hwnd = stdout.match(/^READY (\d+)/m)?.[1];
    const summary = summarize(samples).find((w) => w.hwnd === hwnd);
    return { exitCode: killed ? null : exitCode, stdout, stderr, samples, summary, hwnd };
  } finally {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(scratch, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
}

const near = (a: [number, number, number], b: [number, number, number]) => a.every((v, i) => Math.abs(v - b[i]!) <= 8);
/** Samples of the window on the screen whose most common colour is light and covers half of it or more. */
const lightSamples = (w: Watched) => w.samples.filter((s) => s.hwnd === w.hwnd && onScreen(s) && s.flat >= 0.5 && luma(s.mode) >= 200);

function expectEndedCleanly(run: Watched) {
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain("QUIT");
  expect(run.summary).toBeDefined();
  // The watcher saw the page on the screen before the end.
  expect(run.samples.some((s) => s.hwnd === run.hwnd && onScreen(s) && near(s.mode, PAGE))).toBe(true);
  // What the fixture's own exit listener read, after Sweetview's release: the window is destroyed.
  expect(run.stdout).toContain('"windowExists":false');
}

describe.if(process.platform === "win32")("a window on its way out (D46)", () => {
  for (const mode of ["blocking", "pumped", "dispose", "window-dispose", "run-twice"]) {
    test(
      `${mode}: once its webview is gone, the window is never on the screen, and never flat and light`,
      async () => {
        const run = await watchFixture(mode);
        expectEndedCleanly(run);
        const summary = run.summary!;
        expect({ emptyAfterWebview: summary.emptyAfterWebview, longest: summary.longestEmptyAfterWebview }).toEqual({ emptyAfterWebview: 0, longest: { count: 0, ms: 0, from: -1 } });
        expect(summary.flatLight).toBe(0);
        expect(lightSamples(run)).toEqual([]);
        // The webview went while the process lived, and the window was off the screen before it did.
        expect(summary.lastWebview).not.toBeNull();
        expect(summary.lastOnScreen! <= summary.lastWebview!).toBe(true);
        if (mode === "run-twice") expect(run.stdout).toContain("READY-AGAIN");
      },
      LIVE_TEST_MS,
    );
  }

  test(
    "replace: a window left without its webview shows its dark backdrop, never white",
    async () => {
      const run = await watchFixture("replace");
      expectEndedCleanly(run);
      const summary = run.summary!;
      expect(summary.flatLight).toBe(0);
      expect(lightSamples(run)).toEqual([]);
      const empty = run.samples.filter((s) => s.hwnd === run.hwnd && onScreen(s) && s.webviews === 0 && summary.lastWebview !== null && s.t < summary.lastWebview);
      expect(empty.length).toBeGreaterThan(0);
      expect(empty.filter((s) => s.flat >= 0.5 && !near(s.mode, DARK_BACKDROP) && !near(s.mode, PAGE))).toEqual([]);
      expect(summary.lastOnScreen! <= summary.lastWebview!).toBe(true);
    },
    LIVE_TEST_MS,
  );

  test(
    "tab-close: a tabbed window whose last tab closed shows its dark backdrop, never white",
    async () => {
      const run = await watchFixture("tab-close");
      expectEndedCleanly(run);
      expect(lightSamples(run)).toEqual([]);
      expect(run.summary!.flatLight).toBe(0);
      // The tab's page, then the frame's backdrop where it was: the window's on-screen colours.
      const shown = run.samples.filter((s) => s.hwnd === run.hwnd && onScreen(s));
      expect(shown.some((s) => near(s.mode, DARK_BACKDROP))).toBe(true);
      // A frame with no colour over half of it is DWM's open animation blending the window with what
      // is behind it, as it appears: not a colour of the window's own.
      expect(shown.filter((s) => s.flat >= 0.5 && !near(s.mode, DARK_BACKDROP) && !near(s.mode, PAGE))).toEqual([]);
    },
    LIVE_TEST_MS,
  );
});
