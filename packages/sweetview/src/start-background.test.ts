// WEBVIEW2_DEFAULT_BACKGROUND_COLOR set before WebView2 loads, in a process of its own (the
// variable is read when WebView2 starts): what the screen shows behind a page that paints only a
// stripe, with the window's own backgroundColor and without one. Review round 5, R5-9:
// docs/native/windows.md's sentence on the variable.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const onWindows = process.platform === "win32";

async function startBackground(variable: string, args: string[]): Promise<{ mark: string; below: string; during: string[] }> {
  const fixture = fileURLToPath(new URL("../test/fixtures/start-background.ts", import.meta.url));
  // A profile of its own: WebView2 reads the variable when its browser process starts, and a
  // browser process still running for a shared profile would be reused without it.
  const profile = mkdtempSync(join(tmpdir(), "sweetview-start-background-"));
  const env = { ...process.env, WEBVIEW2_DEFAULT_BACKGROUND_COLOR: variable, WEBVIEW2_USER_DATA_FOLDER: profile };
  const child = Bun.spawn([process.execPath, fixture, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
  const line = out.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`the fixture printed no result:\n${out}`);
  return JSON.parse(line.slice(7));
}

describe.if(onWindows)("WEBVIEW2_DEFAULT_BACKGROUND_COLOR (win32, live)", () => {
  test("a webview in a window with no backgroundColor starts with the variable's colour; a window's backgroundColor wins over it", async () => {
    const plain = await startBackground("FF20A040", ["no-colour"]);
    expect({ mark: plain.mark, below: plain.below }).toEqual({ mark: "#ff00ff", below: "#20a040" });
    const coloured = await startBackground("FF20A040", []);
    expect({ mark: coloured.mark, below: coloured.below, variableShown: coloured.during.includes("#20a040") }).toEqual({ mark: "#ff00ff", below: "#304050", variableShown: false });
  }, 120_000);
});
