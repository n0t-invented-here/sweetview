// Checklist item W1.8: a handler run on the UI thread opens a modal loop of its own and, while it
// is open, the page's calls are still answered, a Worker's wake still drains, and a native timeout
// still fires, under both loop modes. The fixture is its own process, because the modal loop is a
// real MessageBoxW on the UI thread.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const onWindows = process.platform === "win32";

async function runFixture(mode: "blocking" | "pumped") {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-modal-"));
  try {
    const fixture = fileURLToPath(new URL("../test/fixtures/modal-loop.ts", import.meta.url));
    const proc = Bun.spawn([process.execPath, fixture], {
      timeout: 40_000,
      env: { ...process.env, SWEETVIEW_LOOP_MODE: mode, WEBVIEW2_USER_DATA_FOLDER: profile },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    if (code !== 0 || !line) throw new Error(`modal fixture exit ${code}\n${stdout}\n${stderr}`);
    return JSON.parse(line.slice("RESULT ".length)) as {
      mode: string;
      modalOpened: boolean;
      modalReturned: boolean;
      pageCallsInsideModal: number;
      drainsInsideModal: number;
      timeoutsInsideModal: number;
      framesFromWorker: string[];
      inside: Record<"box" | "menu", { pageCalls: number; repliesSeenByPage: number; drains: number; timeouts: number }>;
      menuOpened: boolean;
      menuReturned: number | null;
      timedOut?: boolean;
    };
  } finally {
    // WebView2's subprocesses can keep the profile locked for a moment after the fixture exits.
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

/** Runs `test/fixtures/timers-in-tray-menu.ts` in a process of its own, in `mode`. */
async function runTrayMenuTimers(mode: "blocking" | "pumped", rounds: number) {
  const fixture = fileURLToPath(new URL("../test/fixtures/timers-in-tray-menu.ts", import.meta.url));
  const proc = Bun.spawn([process.execPath, fixture, String(rounds)], {
    timeout: 120_000,
    env: { ...process.env, SWEETVIEW_LOOP_MODE: mode },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  if (code !== 0 || !line) throw new Error(`tray-menu timer fixture exit ${code}\n${stdout}\n${stderr}`);
  return JSON.parse(line.slice("RESULT ".length)) as { mode: string; rounds: number; ticked: number[]; rescued: number; timedOut?: boolean };
}

// Decision D34 (the second review's G1): with the loop's native timers on WM_TIMER, a tray menu
// opened from a deferred job, with every timer already due when its loop first looked at the
// queue, delivered no timer at all, and only a watchdog's Escape closed it.
describe.if(onWindows)("native timers inside a tray menu opened from a deferred job (D34)", () => {
  for (const mode of ["blocking", "pumped"] as const) {
    test(`${mode} loop: an interval set just before the right click ticks inside every menu`, async () => {
      const rounds = 8;
      const report = await runTrayMenuTimers(mode, rounds);
      expect(report.timedOut).toBeUndefined();
      expect(report.mode).toBe(mode);
      expect(report.ticked.length).toBe(rounds);
      expect(report.rescued).toBe(0);
      for (const ticks of report.ticked) expect(ticks).toBeGreaterThanOrEqual(3);
    }, 150_000);
  }
});

describe.if(onWindows)("a modal loop opened by a handler (W1.8)", () => {
  for (const mode of ["blocking", "pumped"] as const) {
    test(`${mode} loop: page calls are answered, a worker's wake drains and a native timeout fires while the dialog is open`, async () => {
      const report = await runFixture(mode);
      expect(report.timedOut).toBeUndefined();
      expect(report.mode).toBe(mode);
      expect(report.modalOpened).toBe(true);
      expect(report.modalReturned).toBe(true);
      expect(report.pageCallsInsideModal).toBeGreaterThanOrEqual(3);
      expect(report.drainsInsideModal).toBeGreaterThanOrEqual(1);
      expect(report.timeoutsInsideModal).toBeGreaterThanOrEqual(1);
      // Answers reached the page while the box was open: the page reported them back inside it.
      expect(report.inside.box.repliesSeenByPage).toBeGreaterThanOrEqual(3);
      // The application's own popup menu: the same, inside TrackPopupMenu's loop, ended by EndMenu.
      expect(report.menuOpened).toBe(true);
      expect(report.menuReturned).toBe(0);
      expect(report.inside.menu.pageCalls).toBeGreaterThanOrEqual(3);
      expect(report.inside.menu.repliesSeenByPage).toBeGreaterThanOrEqual(3);
      expect(report.inside.menu.drains).toBeGreaterThanOrEqual(1);
      expect(report.inside.menu.timeouts).toBeGreaterThanOrEqual(1);
      expect(report.framesFromWorker).toEqual(["written while the box was open", "written while the menu was open"]);
    }, 60_000);
  }
});
