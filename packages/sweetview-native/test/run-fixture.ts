// Runs a webview fixture from `test/fixtures/` in its own process, with a
// WebView2 user data folder of its own (other processes on the machine run
// webviews with other options, and a shared profile makes both fail), and
// returns its `RESULT <json>` line, parsed. The fixture arms its own
// watchdog, so it is never killed from outside.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FixtureRun<R = any> {
  r: R;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function runFixture<R = any>(name: string, args: string[] = [], env: Record<string, string> = {}): Promise<FixtureRun<R>> {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-webview-"));
  try {
    const fixture = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
    const proc = Bun.spawn([process.execPath, fixture, ...args], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`fixture ${name} ${args.join(" ")} gave no result (exit ${exitCode})\n${stdout}\n${stderr}`);
    return { r: JSON.parse(line.slice("RESULT ".length)) as R, exitCode, stdout, stderr };
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
