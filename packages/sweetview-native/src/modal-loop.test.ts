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
      expect(report.framesFromWorker).toEqual(["written while the box was open"]);
    }, 60_000);
  }
});
