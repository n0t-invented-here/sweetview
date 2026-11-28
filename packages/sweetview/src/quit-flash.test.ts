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
import { BACKSTOP } from "../test/fixtures/backstop";
import { flatLight, onScreen, seen, summarize, type Sample, type WindowSummary } from "../test/fixtures/window-watch";

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
  // What is behind the fixture's window is the backstop's magenta, whatever else is on this desktop.
  const backstop = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/backstop.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = backstop.stdout.getReader();
    let backstopText = "";
    while (!/READY \S+\r?\n/.test(backstopText)) {
      const read = await reader.read();
      if (read.done) throw new Error(`the backstop ended: ${await new Response(backstop.stderr).text()}`);
      backstopText += new TextDecoder().decode(read.value);
    }
    reader.releaseLock();
    const backstopRect = backstopText.match(/READY (\S+)/)![1]!;
    const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/quit-flash.ts", import.meta.url))], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, SWEETVIEW_FLASH_TEST: mode, SWEETVIEW_FLASH_GO: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const watcher = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/window-watch.ts", import.meta.url)), String(proc.pid), out, "40000", `${BACKSTOP}@${backstopRect}`], { stdout: "pipe", stderr: "pipe" });
    // The fixture makes nothing before the watcher is watching.
    const watching = watcher.stdout.getReader();
    let watcherText = "";
    while (!watcherText.includes("WATCHING")) {
      const read = await watching.read();
      if (read.done) throw new Error("the watcher ended before it watched");
      watcherText += new TextDecoder().decode(read.value);
    }
    // The rest of what the watcher prints, read on by the same reader.
    const watcherRest = (async () => {
      for (let read = await watching.read(); !read.done; read = await watching.read()) watcherText += new TextDecoder().decode(read.value);
      return watcherText;
    })();
    proc.stdin.write("GO\n");
    proc.stdin.end();
    let killed = false;
    const limit = setTimeout(() => {
      killed = true;
      process.kill(proc.pid);
    }, 40_000);
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(limit);
    const [watcherOut, watcherErr] = await Promise.all([watcherRest, new Response(watcher.stderr).text(), watcher.exited]);
    if (!watcherOut.includes("DONE")) throw new Error(`the watcher failed: ${watcherOut} ${watcherErr}`);
    const samples = readFileSync(out, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Sample);
    const hwnd = stdout.match(/^READY (\d+)/m)?.[1];
    const summary = summarize(samples).find((w) => w.hwnd === hwnd);
    return { exitCode: killed ? null : exitCode, stdout, stderr, samples, summary, hwnd };
  } finally {
    process.kill(backstop.pid);
    await backstop.exited;
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
/** Samples of the window seen on the screen whose most common colour is light and covers half of it or more. */
const lightSamples = (w: Watched) => w.samples.filter((s) => s.hwnd === w.hwnd && seen(s) && s.flat >= 0.5 && luma(s.mode) >= 200);

/**
 * When a check fails, what the watcher saw is printed: each sample of the window from shortly
 * before the first one in question to shortly after the last, with its colours, its rectangle,
 * and what other window the OS named over it.
 */
function explain(run: Watched, flagged: Sample[]): void {
  if (flagged.length === 0) return;
  const mine = run.samples.filter((s) => s.hwnd === run.hwnd);
  const from = flagged[0]!.t - 150;
  const to = flagged.at(-1)!.t + 150;
  const hex = (m: number[]) => "#" + m.map((v) => v.toString(16).padStart(2, "0")).join("");
  const lines = mine
    .filter((s) => s.t >= from && s.t <= to)
    .map((s) => `${flagged.includes(s) ? ">" : " "} t=${s.t} exists=${s.exists} visible=${s.visible} after=${s.visibleAfter} ours=${s.ours}${s.behind ? ` behind=${hex(s.behind.mode)} ${s.behind.flat.toFixed(2)}` : ""} webviews=${s.webviews} at=${s.left},${s.top} ${s.width}x${s.height} ${hex(s.mode)} ${s.flat.toFixed(2)}${s.coveredBy?.length ? ` covered by ${s.coveredBy.join("; ")}` : ""}`);
  console.error(`quit-flash watcher, window ${run.hwnd}, what it saw around ${flagged.length} sample(s) in question:\n${lines.join("\n")}\nfixture stdout:\n${run.stdout}`);
}

/**
 * A run that could not judge what it was there to judge does not pass (R7 and S5 of D46's first
 * review): a read that failed; a read of the window, visible before and after it, that was not
 * the window's with nothing over it (it moved, or showed the backstop); the window outside the
 * backstop. (Whether a presented frame went unread between two reads is not judged: on this
 * display, a 30 Hz one with DWM composing about twice per refresh, neither DWM's count of
 * compositions nor its count of refreshes tells a presented frame from one that is not.)
 */
function expectJudged(run: Watched) {
  const mine = run.samples.filter((s) => s.hwnd === run.hwnd);
  const failed = mine.filter((s) => s.failed !== undefined);
  explain(run, failed);
  expect(failed.map((s) => s.failed)).toEqual([]);
  // Before the window's first read of its own pixels, DWM has not composed it with anything of
  // its own yet (a window just shown), and the backstop it shows is what is behind it; from then
  // on, a read of it that is not its own with nothing over it is one the run cannot judge.
  const firstOwn = mine.findIndex((s) => s.ours === true);
  const unexplained = mine.filter((s, i) => firstOwn >= 0 && i > firstOwn && onScreen(s) && s.ours === false && s.visibleAfter === true && (s.coveredBy?.length ?? 0) === 0);
  explain(run, unexplained);
  expect(unexplained.map((s) => s.t)).toEqual([]);
  const outside = mine.filter((s) => onScreen(s) && s.insideBackstop === false);
  explain(run, outside);
  expect(outside.map((s) => s.t)).toEqual([]);
}

function expectEndedCleanly(run: Watched) {
  expectJudged(run);
  // The watcher must have seen the window whenever it was on the screen: a read with another
  // window over it shows that window, so the run cannot judge this one and does not pass.
  const covered = run.samples.filter((s) => s.hwnd === run.hwnd && onScreen(s) && (s.coveredBy?.length ?? 0) > 0);
  explain(run, covered);
  expect(covered.flatMap((s) => s.coveredBy ?? []).filter((v, i, all) => all.indexOf(v) === i)).toEqual([]);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain("QUIT");
  expect(run.summary).toBeDefined();
  // The watcher saw the page on the screen before the end.
  expect(run.samples.some((s) => s.hwnd === run.hwnd && seen(s) && near(s.mode, PAGE))).toBe(true);
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
        explain(run, [...run.samples.filter((x) => x.hwnd === run.hwnd && (flatLight(x) || lightSamples(run).includes(x)))]);
        expect({ emptyAfterWebview: summary.emptyAfterWebview, longest: summary.longestEmptyAfterWebview }).toEqual({ emptyAfterWebview: 0, longest: { count: 0, ms: 0, from: -1 } });
        expect(summary.flatLight).toBe(0);
        expect(lightSamples(run)).toEqual([]);
        // The webview went while the process lived, and the window was off the screen before it did.
        expect(summary.lastWebview).not.toBeNull();
        expect(summary.lastOnScreen! <= summary.lastWebview!).toBe(true);
        if (mode === "run-twice") {
          // Hidden and alive right after the first run(), and shown again by the second with a
          // view that does not use showOnReady (R8 of D46's first review).
          expect(run.stdout).toContain('AFTER-FIRST {"visible":false,"alive":true,"listed":false}');
          expect(run.stdout).toContain('SECOND {"visible":true}');
        }
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
      const empty = run.samples.filter((s) => s.hwnd === run.hwnd && seen(s) && s.webviews === 0 && summary.lastWebview !== null && s.t < summary.lastWebview);
      expect(empty.length).toBeGreaterThan(0);
      explain(run, [...lightSamples(run), ...empty.filter((s) => s.flat >= 0.5 && !near(s.mode, DARK_BACKDROP) && !near(s.mode, PAGE))].sort((a, b) => a.t - b.t));
      expect(empty.filter((s) => s.flat >= 0.5 && !near(s.mode, DARK_BACKDROP) && !near(s.mode, PAGE))).toEqual([]);
      expect(summary.lastOnScreen! <= summary.lastWebview!).toBe(true);
    },
    LIVE_TEST_MS,
  );

  test(
    "tab-close: a tabbed window whose last tab closed shows its dark backdrop, never white",
    async () => {
      const run = await watchFixture("tab-close");
      // The tab's page, then the frame's backdrop where it was: the window's on-screen colours.
      const shown = run.samples.filter((s) => s.hwnd === run.hwnd && seen(s));
      const other = shown.filter((s) => s.flat >= 0.5 && !near(s.mode, DARK_BACKDROP) && !near(s.mode, PAGE));
      explain(run, [...lightSamples(run), ...other].sort((a, b) => a.t - b.t));
      expectEndedCleanly(run);
      expect(lightSamples(run)).toEqual([]);
      expect(run.summary!.flatLight).toBe(0);
      expect(shown.some((s) => near(s.mode, DARK_BACKDROP))).toBe(true);
      expect(other).toEqual([]);
    },
    LIVE_TEST_MS,
  );
  test(
    "run-twice-own-hide: the application's own hide() between two run()s stands: the second does not show the window",
    async () => {
      const run = await watchFixture("run-twice-own-hide");
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('AFTER-FIRST {"visible":false,"alive":true,"listed":false}');
      expect(run.stdout).toContain('SECOND {"visible":false}');
    },
    LIVE_TEST_MS,
  );
});

