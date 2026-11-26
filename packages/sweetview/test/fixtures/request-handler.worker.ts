import { defineService } from "@n1h/sweetview/ipc";
import { hostRequestHandler, hostService, type RequestHandler } from "@n1h/sweetview/worker";

const seen: string[] = [];
let pending = () => {};
const service = defineService<{ paths: [null, string[]] }, { pending: null }>((emit) => {
  pending = () => emit("pending", null);
  return { methods: { paths: () => seen } };
});

const onRequest: RequestHandler = async (request) => {
  const url = new URL(request.url);
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
    case "/pixel.gif":
      return new Response(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"), {
        headers: { "Content-Type": "image/gif" },
      });
    case "/sandbox.html":
      if (url.hostname === "frames.webview.localhost" || url.protocol === "webview-frames:") {
        return new Response(
          '<!doctype html><script>parent.postMessage({href: location.href, origin: self.origin}, "*");</script>',
          { headers: { "Content-Type": "text/html" } },
        );
      }
      break;
    case "/throws":
      throw new Error("Private handler error");
    case "/pending":
      pending();
      return new Promise<Response>(() => {});
  }
  return new Response("Not Found", { status: 404 });
};

if (process.env.SWEETVIEW_REQUEST_TEST === "request-only") hostRequestHandler(onRequest);
else hostService(service, process.env.SWEETVIEW_REQUEST_TEST === "no-handler" ? undefined : { onRequest });
