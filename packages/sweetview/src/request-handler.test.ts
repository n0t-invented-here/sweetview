import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestResponseAssembler, requestError, runNativeRequest, writeRequestResponse, writeStreamingResponse, type NativeRequestResponse, type StreamingResponseFrame } from "./request-response";
import { Ring } from "./ring";
import type { NativeResponse } from "./messages";

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
      if (response && !("kind" in response)) result.push(response);
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

test("forwards stream frames before EOF and splits oversized chunks, with a legacy buffering fallback", async () => {
  const ring = new Ring(Ring.create(128));
  const assembler = new RequestResponseAssembler();
  const legacy = new RequestResponseAssembler(true);
  const frames: StreamingResponseFrame[] = [];
  const buffered: NativeRequestResponse[] = [];
  const wake = () => {
    ring.acknowledgeWakeup();
    for (const bytes of ring.drain()) {
      const frame = assembler.push(bytes);
      const response = legacy.push(bytes);
      if (frame && "kind" in frame) frames.push(frame);
      if (response && !("kind" in response)) buffered.push(response);
    }
  };
  const head = { id: "18446744073709551615", status: 201, headers: [["X-Test", "value"]] as [string, string][] };
  const chunk = Uint8Array.from({ length: 250 }, (_, index) => index);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (value) => { controller = value; } });
  const task = writeStreamingResponse(ring, head, stream.getReader(), wake);
  expect(frames).toEqual([{ kind: "begin", ...head }]);
  controller.enqueue(chunk);
  await Promise.resolve();
  const pieces = frames.filter((frame) => frame.kind === "chunk");
  expect(pieces).toHaveLength(3);
  expect(pieces.every((frame) => frame.id === head.id)).toBe(true);
  expect(Uint8Array.from(pieces.flatMap((frame) => [...frame.body]))).toEqual(chunk);
  expect(buffered).toEqual([]);
  controller.close();
  await task;
  expect(frames.at(-1)).toEqual({ kind: "end", id: head.id });
  expect(buffered).toEqual([{ ...head, body: chunk }]);
  expect(stream.locked).toBe(false);

  const failed = new ReadableStream<Uint8Array>({
    pull(value) {
      value.error(new Error("source failed"));
    },
  });
  await writeStreamingResponse(ring, { ...head, id: "2" }, failed.getReader(), wake);
  expect(frames.at(-1)).toEqual({ kind: "abort", id: "2" });
  expect(buffered.at(-1)).toEqual(requestError(2n, 500, "Internal Server Error"));
  expect(failed.locked).toBe(false);
});

// Which engine features the live tests can count on. Windows: the Rust binding has all of
// them. macOS: whatever the webview library in use has, probed as before (a library with the
// request handler is needed: WEBVIEW_PATH, or a sibling checkout of the bindings).
let resolvedLibPath: string | undefined;
let live = process.platform === "win32";
let nativeStreaming = live;
let nativeDrop = live;
if (process.platform === "darwin") {
  const lib = await import("./darwin-webview-lib");
  const siblingLib = fileURLToPath(new URL("../../../../sweetview-webview-bun/build/libwebview.dylib", import.meta.url));
  const libPath = process.env.WEBVIEW_PATH ?? (await Bun.file(siblingLib).exists() ? siblingLib : undefined);
  resolvedLibPath = libPath ?? await lib.webviewLibPath().catch(() => undefined);
  live = resolvedLibPath !== undefined && lib.requestHandlerCalls(resolvedLibPath) !== undefined;
  nativeStreaming = resolvedLibPath !== undefined && lib.streamingResponseCalls(resolvedLibPath) !== undefined;
  nativeDrop = resolvedLibPath !== undefined && lib.fileDropHandlerCall(resolvedLibPath) !== undefined;
}

async function runLive(mode: string) {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-request-handler-"));
  try {
    const name = mode !== "drop" ? "request-handler" : process.platform === "darwin" ? "webview-file-drop.darwin" : "webview-file-drop";
    const fixture = fileURLToPath(new URL(`../test/fixtures/${name}.ts`, import.meta.url));
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
    // macOS logs this line itself when a process reads a file URL from a
    // pasteboard it filled, which is how the drop fixture stands in for Finder.
    const ownStderr = mode === "drop" && process.platform === "darwin"
      ? stderr.split("\n").filter((line) => !line.startsWith("sandbox_extension_consume failed")).join("\n")
      : stderr;
    expect(ownStderr).toBe("");
    const result = JSON.parse(line.slice("RESULT ".length));
    expect(result.timedOut).toBe(false);
    expect(result.report?.error).toBeUndefined();
    return result;
  } finally {
    // WebView2's subprocesses can keep the profile locked after Bun exits, on a slow machine for
    // longer than a test should wait: a folder still locked then is left in the temp directory.
    // What this test asserts is what the page got, not when WebView2 lets go of its files.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
        if (attempt === 99) {
          console.warn(`request-handler.test: a WebView2 profile folder under the temp directory is still locked (${code}) and was left there`);
          break;
        }
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
  expect(report.stream).toEqual({ status: 200, body: `one:${"x".repeat(8192)}:three` });
  // WebView2 hands the page a response only once its body has ended; a
  // WKURLSchemeTask delivers each chunk as it is written, so the page's first
  // read returns before the worker's stream has closed.
  if (nativeStreaming) expect(report.streamFirstReadAfterEof).toBe(process.platform === "win32");
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

test.if(process.platform === "win32" && nativeDrop)("registers and clears file drops on a live WebView2 as Window listeners change", async () => {
  const { report } = await runLive("drop");
  expect(report.states).toEqual([true, true, false, true]);
  expect(report.delivered).toEqual([report.path]);
  expect(report.disposed).toBe(true);
}, 30_000);

test.if(process.platform === "darwin" && nativeDrop)("registers and clears file drops on a live WKWebView as Window listeners change, and delivers a dropped file", async () => {
  const { report } = await runLive("drop");
  // One listener, a second replacing the first, none, one again: the file
  // drop handler takes an external file drag exactly while a listener exists,
  // and WebKit is handed the drag otherwise.
  expect(report.states).toEqual([true, true, false, true]);
  // The drop is accepted at every step without WebKit seeing it, and the
  // listener runs after performDragOperation: returned, with the file's path.
  expect(report.dropSteps).toEqual({ entered: true, updated: true, prepared: true, performed: true, deliveredInsidePerform: false });
  expect(report.webkitSawDrop).toBe(false);
  // The fixture's NSURL fileURLWithPath: decomposes the name's "ü" (file
  // system representation), so the two are compared in one normal form.
  expect(report.delivered.map((path: string) => path.normalize("NFC"))).toEqual([report.path.normalize("NFC")]);
  expect(report.disposed).toBe(true);
}, 30_000);

test.if(live)("returns clean errors for synchronous Promises and absent worker handlers", async () => {
  const sync = await runLive("sync");
  expect(sync.report.status).toBe(500);
  expect(sync.report.body).toContain('onRequest: "worker"');
  expect((await runLive("no-handler")).report).toEqual({ status: 404, body: "Not Found" });
  expect((await runLive("request-only")).report).toEqual({ status: 200, body: "<!doctype html><p id=dynamic>worker HTML</p>" });
}, 70_000);

// D47. A worker's streamed body on a live WebView2: every byte reaches the page, in order.
// WebView2 reads each chunk out of the binding as it is written but hands the page none of the
// body before it ends (WebView2Feedback #3519; Microsoft's ICoreWebView2WebResourceResponse
// reference requires all content by the time the deferral completes), as the C++ library's own
// test asserted: the page cannot acknowledge a part before the next is written, and the whole
// body waits in WebView2 until the end. Both are asserted as measured: if a WebView2 Runtime
// starts handing the page bytes before the end, this fails, and D47, the docs and these
// assertions change.
test.if(live && process.platform === "win32")("a worker's streamed body arrives whole and in order, and WebView2 hands it to the page at its end", async () => {
  const { report } = await runLive("pace");
  expect(report.live).toBe("live one;live two;live three;");
  const bulkBytes = 24 * 1024 * 1024 + 4321;
  expect(report.bulk).toEqual({ total: bulkBytes, bad: null });
  expect(report.pacing.produced).toBe(bulkBytes);
  // No part reached the page before the next was written...
  expect(report.pacing.liveAcks).toEqual([false, false, false]);
  // ...and the page read nothing of the body before the worker ended it (the worker waited up to
  // 3 s for the page's first read before ending), so all of it was ahead of the page.
  expect(report.pacing.firstBeforeEnd).toBe(false);
  expect(report.pacing.maxAhead).toBe(bulkBytes);
}, 30_000);
