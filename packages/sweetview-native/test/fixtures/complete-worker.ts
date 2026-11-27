// Answers requests from a thread other than the one running the webview: the
// pattern for async work while Webview.run() blocks its thread, and proof
// that completing is safe to call from any thread, including after the
// webview is destroyed.
//
// Brought over from the bindings' test/fixtures/complete-worker.ts (W2.7).
// The raw C calls, used to hand over header JSON that JSON.stringify never
// makes, are the binding's own functions, which take the header JSON text as
// it is. The raw call with a NULL chunk and a length has no counterpart: a
// chunk is a Uint8Array, which always carries its own length.

import { binding } from "../../src/binding";
import {
  beginWebviewResponse,
  completeWebviewRequest,
  endWebviewResponse,
  WebviewError,
  writeWebviewResponseChunk,
  type WebviewRequest,
} from "../../src/index";

declare var self: Worker;

const raw = binding();

// A 1x1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

// The page acknowledges each Server-Sent Event it receives (through a host
// binding the main thread relays here). Event n+1 is written once the ack for
// event n arrives or ACK_WAIT_MS passes, and the last event records which:
// an engine that delivers partial bodies acks before the next write; WebView2,
// which hands the page an intercepted response only once the body has ended,
// never does.
const ACK_WAIT_MS = 1500;
const sseAckWaiters = new Map<number, () => void>();
function sseAck(n: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sseAckWaiters.delete(n);
      resolve(false);
    }, timeoutMs);
    sseAckWaiters.set(n, () => {
      clearTimeout(timer);
      sseAckWaiters.delete(n);
      resolve(true);
    });
  });
}

function sseEvent(n: number, data: Record<string, unknown>): string {
  return `id: ${n}\ndata: ${JSON.stringify({ n, ...data })}\n\n`;
}

async function streamSse(handle: number, id: bigint) {
  // Refused before anything is sent, leaving the request open: bad header
  // JSON and a bad status for begin (both -2).
  const badBegin = raw.beginResponse(handle, id, 200, '{"Bad Name":"x"}');
  const badStatus = errorCode(() => beginWebviewResponse(handle, id, { status: 42 }));

  beginWebviewResponse(handle, id, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
  const duplicateBegin = errorCode(() => beginWebviewResponse(handle, id));

  // Event 1, then wait for the page to have it.
  const ack1 = sseAck(1, ACK_WAIT_MS);
  writeWebviewResponseChunk(handle, id, sseEvent(1, { writtenAt: Date.now() }));
  const ack1BeforeEvent2 = await ack1;
  await Bun.sleep(250);

  // Event 2, split across two chunks with a pause between them: the page
  // must see one event once both halves are in.
  const ack2 = sseAck(2, ACK_WAIT_MS);
  const event2 = sseEvent(2, { writtenAt: Date.now() });
  const half = Math.floor(event2.length / 2);
  writeWebviewResponseChunk(handle, id, event2.slice(0, half));
  await Bun.sleep(100);
  writeWebviewResponseChunk(handle, id, new TextEncoder().encode(event2.slice(half)));
  const ack2BeforeEvent3 = await ack2;
  await Bun.sleep(250);

  const event3WrittenAt = Date.now();
  writeWebviewResponseChunk(
    handle,
    id,
    sseEvent(3, { writtenAt: event3WrittenAt, ack1BeforeEvent2, ack2BeforeEvent3, badBegin, badStatus, duplicateBegin }),
  );
  endWebviewResponse(handle, id);
  // After the end: a second end and a late chunk do nothing.
  errorCode(() => endWebviewResponse(handle, id));
  errorCode(() => writeWebviewResponseChunk(handle, id, "late"));
}

// Header JSON the binding must refuse with WEBVIEW_ERROR_INVALID_ARGUMENT (-2)
// before anything is queued, leaving the request open.
const BAD_HEADERS_JSON = [
  '{"X-Example":trueish}', // trailing text after a literal
  '{"X-Example":"a\\u0000b"}', // escaped NUL
  '{"Bad Name":"a"}', // not an RFC 9110 token
  '{"X-A":"\\ud83d"}', // lone surrogate
  '{"X-A":"a\tb"}', // raw control character in a string
  JSON.stringify({ "X-Evil": "ok\r\nX-Injected: yes" }), // CR LF in a value
];

function errorCode(fn: () => void): number | string {
  try {
    fn();
    return 0;
  } catch (e) {
    return e instanceof WebviewError ? e.code : String(e);
  }
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data as { handle: number; request?: WebviewRequest; afterDestroy?: { id: string }; sseAck?: number };
  if (data.sseAck !== undefined) {
    sseAckWaiters.get(data.sseAck)?.();
    return;
  }
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
    // Every bad header set is refused, and the request stays open for the
    // real answer below.
    const rawRejections = BAD_HEADERS_JSON.map((json) => raw.completeRequest(handle, request.id, 200, json, null));
    const badHeaders: Record<string, string>[] = [{ "Bad Name": "x" }, { "X-Evil": "ok\r\nX-Injected: yes" }, { "X-Nul": "a\0b" }, { "": "empty name" }];
    const wrapperRejections = badHeaders.map((headers) => errorCode(() => completeWebviewRequest(handle, request.id, { status: 200, headers })));
    const header = request.headers.find(([n]) => n.toLowerCase() === "x-sweetview-test")?.[1] ?? null;
    completeWebviewRequest(handle, request.id, {
      status: 201,
      headers: [
        ["Content-Type", "application/json"],
        ["X-Multi", "a"],
        ["X-Multi", "b"],
        ["X-Raw-Rejections", rawRejections.join(",")],
        ["X-Wrapper-Rejections", wrapperRejections.join(",")],
      ],
      body: JSON.stringify({
        method: request.method,
        query: url.search,
        header,
        body: request.body ? new TextDecoder().decode(request.body) : null,
      }),
    });
    return;
  }
  completeWebviewRequest(handle, request.id, { status: 404 });
};

postMessage("ready");
