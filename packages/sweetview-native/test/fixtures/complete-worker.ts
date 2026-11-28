// Answers requests from a thread other than the one running the webview: the
// pattern for async work while Webview.run() blocks its thread, and proof
// that the wrappers and the binding's own functions reach the native call
// from a Worker, including after the webview is destroyed.
//
// Brought over from the bindings' test/fixtures/complete-worker.ts (W2.7).
// The raw call with a NULL chunk and a length has no counterpart: a chunk is a
// Uint8Array, which always carries its own length. The header JSON the
// binding refuses, an event split over writes and the single connection of
// an EventSource are proven in Rust (`crates/sweetview-platform-webview/tests/serving_os.rs`).

import { binding } from "../../../sweetview/src/binding";
import {
  beginWebviewResponse,
  completeWebviewRequest,
  endWebviewResponse,
  WebviewError,
  writeWebviewResponseChunk,
  type WebviewRequest,
} from "../../../sweetview/src/raw-webview";

declare var self: Worker;

const raw = binding();

// A 1x1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

function sseEvent(n: number, data: Record<string, unknown>): string {
  return `id: ${n}\ndata: ${JSON.stringify({ n, ...data })}\n\n`;
}

async function streamSse(handle: number, id: bigint) {
  // A bad status is refused by the wrapper (-2) before anything is sent, leaving the request open.
  const badStatus = errorCode(() => beginWebviewResponse(handle, id, { status: 42 }));
  beginWebviewResponse(handle, id, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
  const duplicateBegin = errorCode(() => beginWebviewResponse(handle, id));
  writeWebviewResponseChunk(handle, id, sseEvent(1, {}));
  await Bun.sleep(50);
  writeWebviewResponseChunk(handle, id, new TextEncoder().encode(sseEvent(2, {})));
  await Bun.sleep(50);
  writeWebviewResponseChunk(handle, id, sseEvent(3, { badStatus, duplicateBegin }));
  endWebviewResponse(handle, id);
}

function errorCode(fn: () => void): number | string {
  try {
    fn();
    return 0;
  } catch (e) {
    return e instanceof WebviewError ? e.code : String(e);
  }
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data as { handle: number; request?: WebviewRequest; afterDestroy?: { id: string } };
  const handle = data.handle;

  if (data.afterDestroy) {
    // The webview is gone: both the wrapper and the binding's own call must
    // refuse with WEBVIEW_ERROR_INVALID_STATE (-3), not crash.
    const id = BigInt(data.afterDestroy.id);
    postMessage({
      afterDestroy: {
        wrapper: errorCode(() => completeWebviewRequest(handle, id, { status: 200, body: "late" })),
        raw: raw.completeRequest(handle, id, 200, '{"X-A":"1"}', null),
      },
    });
    return;
  }

  const request = data.request!;
  const url = new URL(request.url);
  if (url.pathname === "/sse") {
    // Streamed from this thread while run() blocks the webview's.
    await streamSse(handle, request.id);
    return;
  }
  // Real async work on this thread's event loop.
  await Bun.sleep(5);
  if (url.pathname === "/dynamic.png") {
    completeWebviewRequest(handle, request.id, { headers: { "Content-Type": "image/png" }, body: PNG });
    return;
  }
  if (url.pathname === "/api/echo") {
    // Every bad header set is refused by the wrapper (-2), and the request
    // stays open for the real answer below.
    const badHeaders: Record<string, string>[] = [{ "Bad Name": "x" }, { "X-Evil": "ok\r\nX-Injected: yes" }, { "X-Nul": "a\0b" }, { "": "empty name" }];
    const wrapperRejections = badHeaders.map((headers) => errorCode(() => completeWebviewRequest(handle, request.id, { status: 200, headers })));
    const header = request.headers.find(([n]) => n.toLowerCase() === "x-sweetview-test")?.[1] ?? null;
    completeWebviewRequest(handle, request.id, {
      status: 201,
      headers: [
        ["Content-Type", "application/json"],
        ["X-Multi", "a"],
        ["X-Multi", "b"],
        ["X-Wrapper-Rejections", wrapperRejections.join(",")],
      ],
      body: JSON.stringify({
        method: request.method,
        header,
        body: request.body ? new TextDecoder().decode(request.body) : null,
      }),
    });
    return;
  }
  completeWebviewRequest(handle, request.id, { status: 404 });
};

postMessage("ready");
