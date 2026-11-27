import { defineService } from "@n1h/sweetview/ipc";
import { hostRequestHandler, hostService, type RequestHandler } from "@n1h/sweetview/worker";

const seen: string[] = [];
let pending = () => {};
let streamEof = () => {};
const service = defineService<{ paths: [null, string[]] }, { pending: null; streamEof: null }>((emit) => {
  pending = () => emit("pending", null);
  streamEof = () => emit("streamEof", null);
  return { methods: { paths: () => seen } };
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
