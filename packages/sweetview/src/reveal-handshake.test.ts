// D49's reveal on the ready signal, when the page does not answer it as the host asks (second
// review, T1 and T2). Each case runs test/fixtures/reveal-handshake.ts in a process of its own
// with a fresh WebView2 profile; it shows a window and injects no input.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function run(mode: string): Promise<Record<string, unknown>> {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-reveal-"));
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/reveal-handshake.ts", import.meta.url)), mode], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
  const line = out.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`reveal-handshake ${mode} printed no result:\n${out}\n${err}`);
  return JSON.parse(line.slice(7));
}

describe.if(process.platform === "win32")("the reveal on the ready signal (win32, live)", () => {
  test("a page that never answers the drawn request still has its window put on the screen, at the reveal's bound, with no readyTimeoutMs", async () => {
    expect(await run("bound")).toEqual({
      seen: [
        { at: "before the bound", visible: true, cloaked: true },
        { at: "after the bound", visible: true, cloaked: false },
      ],
    });
  }, 60_000);

  test("an application's own method named __sweetview.drawn is the application's: the host takes only the answers to its own requests", async () => {
    expect(await run("route")).toEqual({ routed: ["mine"], answer: "the application's" });
  }, 60_000);
});
