import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestResponseAssembler, runNativeRequest, writeRequestResponse, type NativeRequestResponse } from "./request-response";
import { Ring } from "./ring";
import type { NativeResponse } from "./messages";
import { requestHandlerCalls, webviewLibPath } from "./webview-lib";

test("a synchronous handler that returns a rejected Promise gets an immediate 500", () => {
  const answer = runNativeRequest(
    () => Promise.reject(new Error("private error")) as unknown as NativeResponse,
    { id: 1n, method: "GET", url: "http://webview.localhost/dynamic", headers: [], body: new Uint8Array() },
  );
  expect(answer.status).toBe(500);
  expect(new TextDecoder().decode(answer.body)).toContain('onRequest: "worker"');
});

test("binary response frames preserve uint64 IDs, repeated headers and arbitrary bytes", () => {
  const ring = new Ring(Ring.create(128));
  const assembler = new RequestResponseAssembler();
  const result: NativeRequestResponse[] = [];
  const wake = () => {
    ring.acknowledgeWakeup();
    for (const bytes of ring.drain()) {
      expect(bytes[0]).toBe(0);
      const response = assembler.push(bytes);
      if (response) result.push(response);
    }
  };
  const large = {
    id: "18446744073709551615",
    status: 201,
    headers: [["X-Test", "a"], ["X-Test", "b"]] as [string, string][],
    body: Uint8Array.from({ length: 1000 }, (_, i) => i % 256),
  };
  const empty = { ...large, id: "1", status: 204, body: new Uint8Array() };
  writeRequestResponse(ring, large, wake);
  writeRequestResponse(ring, empty, wake);
  expect(result).toEqual([large, empty]);
});

const nativeFile = process.platform === "darwin" ? "libwebview.dylib" : "libwebview.dll";
const siblingLib = fileURLToPath(new URL(`../../../../sweetview-webview-bun/build/${nativeFile}`, import.meta.url));
const libPath = process.env.WEBVIEW_PATH ?? (await Bun.file(siblingLib).exists() ? siblingLib : undefined);
const desktop = process.platform === "win32" || process.platform === "darwin";
const resolvedLibPath = desktop
  ? libPath ?? await webviewLibPath().catch(() => undefined)
  : undefined;
const live = resolvedLibPath !== undefined && requestHandlerCalls(resolvedLibPath) !== undefined;

async function runLive(mode: string) {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-request-handler-"));
  try {
    const fixture = fileURLToPath(new URL("../test/fixtures/request-handler.ts", import.meta.url));
    const proc = Bun.spawn([process.execPath, fixture], {
      timeout: 20_000,
      env: {
        ...process.env,
        WEBVIEW_PATH: resolvedLibPath,
        WEBVIEW2_USER_DATA_FOLDER: profile,
        SWEETVIEW_REQUEST_TEST: mode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    const line = stdout.split(/\r?\n/).find((line) => line.startsWith("RESULT "));
    if (code !== 0 || !line) throw new Error(`Live fixture exit ${code}\n${stdout}\n${stderr}`);
    const result = JSON.parse(line.slice("RESULT ".length));
    expect(result.timedOut).toBe(false);
    expect(result.report?.error).toBeUndefined();
    return result;
  } finally {
    // WebView2's subprocesses can keep the profile locked after Bun exits.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 99 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
        await Bun.sleep(100);
      }
    }
  }
}

test.if(live)("serves worker routes and isolates the frames origin in a real desktop webview", async () => {
  const { report, pending, escaped, assetOrigin, framesOrigin } = await runLive("worker");
  expect(report.asset).toBe("static asset");
  expect(report.paths).not.toContain("/asset.txt");
  expect(report.paths).toContain("/dynamic");
  expect(report.dynamic).toBe("worker HTML");
  expect(report.echo).toEqual({
    status: 201,
    multi: "one, two",
    payload: { method: "POST", header: "from page", body: { hello: "world" } },
  });
  expect(report.binary).toEqual({ length: 20_480, correct: true });
  expect(report.image).toEqual([1, 1]);
  expect(report.parentOrigin).toBe(assetOrigin);
  expect(report.frame).toEqual({
    origin: framesOrigin,
    data: {
      origin: framesOrigin,
      href: `${framesOrigin}/sandbox.html`,
      hasRpc: false,
      parentDoc: "SecurityError",
      crossOriginFetch: "blocked",
      sameOriginSubresource: { source: "frames" },
    },
  });
  expect(report.frameAccess).toBe("SecurityError");
  expect(report.frameRoutesOnAssetOrigin).toEqual([404, 404]);
  expect(escaped).toBe(false);
  expect(report.failure).toEqual([500, "text/plain", "Internal Server Error"]);
  expect(report.missing).toBe(404);
  expect(pending).toBe(true);
}, 30_000);

test.if(live)("returns clean errors for synchronous Promises and absent worker handlers", async () => {
  const sync = await runLive("sync");
  expect(sync.report.status).toBe(500);
  expect(sync.report.body).toContain('onRequest: "worker"');
  expect((await runLive("no-handler")).report).toEqual({ status: 404, body: "Not Found" });
  expect((await runLive("request-only")).report).toEqual({ status: 200, body: "<!doctype html><p id=dynamic>worker HTML</p>" });
}, 70_000);
