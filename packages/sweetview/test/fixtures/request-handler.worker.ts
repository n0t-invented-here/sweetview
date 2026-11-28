import { defineService } from "@n1h/sweetview/ipc";
import { hostRequestHandler, hostService, type RequestHandler } from "@n1h/sweetview/worker";

const seen: string[] = [];
let pending = () => {};
let streamEof = () => {};

// "pace" mode. /live writes its next part only once the page has acknowledged the one before
// (or 2 s have passed): `liveAcks` records, per part, whether the page had it in time. /bulk is
// BULK_BYTES of a pattern, produced as fast as the stream is read; the page reports how much it
// has read, and `maxAhead` is the most the worker has produced beyond that (bytes held by the
// ring, the binding or WebView2).
const BULK_BYTES = 24 * 1024 * 1024 + 4321;
const BULK_PART = 256 * 1024;
const liveAcks: boolean[] = [];
let acked = 0;
let ackWaiter: (() => void) | undefined;
let produced = 0;
let consumed = 0;
let maxAhead = 0;
// Whether the page had read any of /bulk before the worker ended it: once everything is
// produced, the worker waits up to 3 s for the page's first report before it closes the body,
// so the worker, which ends the response, decides.
let firstBeforeEnd: boolean | undefined;
let consumedWaiter: (() => void) | undefined;
const waitForFirstRead = () =>
  new Promise<boolean>((resolve) => {
    if (consumed > 0) return resolve(true);
    const timer = setTimeout(() => {
      consumedWaiter = undefined;
      resolve(false);
    }, 3000);
    consumedWaiter = () => {
      clearTimeout(timer);
      consumedWaiter = undefined;
      resolve(true);
    };
  });
const waitForAck = (n: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      ackWaiter = undefined;
      resolve(false);
    }, 2000);
    const check = () => {
      if (acked < n) return;
      clearTimeout(timer);
      ackWaiter = undefined;
      resolve(true);
    };
    ackWaiter = check;
    check();
  });

const service = defineService<{
  paths: [null, string[]];
  ack: [number, void];
  consumed: [number, void];
  pacing: [null, { liveAcks: boolean[]; produced: number; maxAhead: number; firstBeforeEnd: boolean | undefined }];
}, { pending: null; streamEof: null }>((emit) => {
  pending = () => emit("pending", null);
  streamEof = () => emit("streamEof", null);
  return {
    methods: {
      paths: () => seen,
      ack: (n: number) => {
        acked = Math.max(acked, n);
        ackWaiter?.();
      },
      consumed: (n: number) => {
        consumed = n;
        consumedWaiter?.();
      },
      pacing: () => ({ liveAcks, produced, maxAhead, firstBeforeEnd }),
    },
  };
});

const onRequest: RequestHandler = async (request) => {
  const url = new URL(request.url);
  const isFramesOrigin = url.origin === "http://frames.webview.localhost"
    || (url.protocol === "webview-frames:" && url.host === "localhost");
  seen.push(url.pathname);
  switch (url.pathname) {
    case "/dynamic":
      return new Response("<!doctype html><p id=dynamic>worker HTML</p>", { headers: { "Content-Type": "text/html" } });
    case "/api/echo": {
      await Bun.sleep(10);
      const headers = new Headers([["x-multi", "one"], ["x-multi", "two"]]);
      return Response.json({
        method: request.method,
        header: request.headers.get("x-sweetview-test"),
        body: await request.json(),
      }, { status: 201, headers });
    }
    case "/binary":
      return new Response(Uint8Array.from({ length: 20_480 }, (_, i) => i % 251), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    case "/stream": {
      const chunks = ["one:", "x".repeat(8192), ":three"];
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(30);
          const chunk = chunks.shift();
          if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
          else {
            streamEof();
            controller.close();
          }
        },
      }), { headers: { "Content-Type": "text/plain" } });
    }
    case "/live": {
      const parts = ["live one;", "live two;", "live three;"];
      const encoder = new TextEncoder();
      let next = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (next > 0) liveAcks.push(await waitForAck(next));
          if (next === parts.length) controller.close();
          else controller.enqueue(encoder.encode(parts[next++]));
        },
      }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    case "/bulk":
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (produced >= BULK_BYTES) {
            firstBeforeEnd = await waitForFirstRead();
            controller.close();
            return;
          }
          const n = Math.min(BULK_PART, BULK_BYTES - produced);
          const part = new Uint8Array(n);
          for (let k = 0; k < n; k++) {
            const i = produced + k;
            part[k] = (i % 251) ^ (Math.floor(i / 65536) % 256);
          }
          produced += n;
          maxAhead = Math.max(maxAhead, produced - consumed);
          controller.enqueue(part);
        },
      }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/octet-stream" } });
    case "/pixel.gif":
      return new Response(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"), {
        headers: { "Content-Type": "image/gif" },
      });
    case "/sandbox.html":
      if (isFramesOrigin) {
        const assetOrigin = url.protocol === "webview-frames:" ? "webview://localhost" : "http://webview.localhost";
        return new Response(
          `<!doctype html><script>
            (async () => {
              const result = {
                href: location.href,
                origin: self.origin,
                hasRpc: typeof window.__sweetview_rpc !== "undefined" || typeof window.__webview__ !== "undefined",
              };
              try { void parent.document; result.parentDoc = "allowed"; }
              catch (error) { result.parentDoc = error.name; }

              const escape = JSON.stringify({ id: "999", method: "__sweetview_rpc", params: ["iframeEscaped", null] });
              window.chrome?.webview?.postMessage?.(escape);
              window.webkit?.messageHandlers?.__webview__?.postMessage?.(escape);

              try {
                await fetch(${JSON.stringify(assetOrigin + "/asset.txt")});
                result.crossOriginFetch = "allowed";
              } catch {
                result.crossOriginFetch = "blocked";
              }
              result.sameOriginSubresource = await (await fetch("/frame-data.json")).json();
              parent.postMessage(result, "*");
            })().catch((error) => parent.postMessage({ error: String(error.stack || error) }, "*"));
          </script>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      break;
    case "/frame-data.json":
      if (isFramesOrigin) return Response.json({ source: "frames" });
      break;
    case "/throws":
      throw new Error("Private handler error");
    case "/pending": {
      let started = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!started) {
            started = true;
            controller.enqueue(Uint8Array.of(1));
            return;
          }
          pending();
          return new Promise<void>(() => {});
        },
      }, { highWaterMark: 0 }));
    }
  }
  return new Response("Not Found", { status: 404 });
};

if (process.env.SWEETVIEW_REQUEST_TEST === "request-only") hostRequestHandler(onRequest);
else hostService(service, process.env.SWEETVIEW_REQUEST_TEST === "no-handler" ? undefined : { onRequest });
