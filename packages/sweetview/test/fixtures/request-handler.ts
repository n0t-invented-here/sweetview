import { ASSET_ORIGIN, FRAMES_ORIGIN, createApp, type NativeResponse } from "@n1h/sweetview";

const mode = process.env.SWEETVIEW_REQUEST_TEST;
const isWorkerCase = mode === "worker";
const script = isWorkerCase ? `
  (async () => {
    const report = {};
    const frameResult = new Promise((resolve) => {
      window.addEventListener("message", (event) => {
        if (event.source === frame.contentWindow) resolve({ origin: event.origin, data: event.data });
      });
    });
    const frame = document.createElement("iframe");
    frame.src = ${JSON.stringify(`${FRAMES_ORIGIN}/sandbox.html`)};
    document.body.append(frame);
    try {
      report.parentOrigin = self.origin;
      report.asset = await (await fetch("/asset.txt")).text();
      const html = await (await fetch("/dynamic")).text();
      report.dynamic = new DOMParser().parseFromString(html, "text/html").querySelector("#dynamic").textContent;
      const echo = await fetch("/api/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sweetview-Test": "from page" },
        body: JSON.stringify({ hello: "world" }),
      });
      report.echo = { status: echo.status, multi: echo.headers.get("X-Multi"), payload: await echo.json() };
      const bytes = new Uint8Array(await (await fetch("/binary")).arrayBuffer());
      report.binary = { length: bytes.length, correct: bytes.every((byte, i) => byte === i % 251) };
      const streamed = await fetch("/stream");
      const reader = streamed.body.pipeThrough(new TextDecoderStream()).getReader();
      let streamBody = "";
      const first = await reader.read();
      report.streamFirstReadAfterEof = await window.__sweetview_rpc("streamFirstReadAfterEof", null);
      if (!first.done) streamBody += first.value;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamBody += value;
      }
      report.stream = { status: streamed.status, body: streamBody };
      const image = new Image();
      image.src = "/pixel.gif";
      await image.decode();
      report.image = [image.naturalWidth, image.naturalHeight];
      report.frame = await frameResult;
      try { report.frameAccess = typeof frame.contentWindow.document; }
      catch (err) { report.frameAccess = err.name; }
      report.frameRoutesOnAssetOrigin = await Promise.all(
        ["/sandbox.html", "/frame-data.json"].map(async (path) => (await fetch(path)).status),
      );
      const failed = await fetch("/throws");
      report.failure = [failed.status, failed.headers.get("Content-Type"), await failed.text()];
      report.missing = (await fetch("/missing")).status;
      report.paths = await window.__sweetview_rpc("paths", null);
      fetch("/pending").catch(() => {});
    } catch (err) {
      report.error = String(err.stack || err);
    }
    await window.__sweetview_rpc("report", report);
  })();
` : `
  (async () => {
    try {
      const response = await fetch("/dynamic");
      await window.__sweetview_rpc("report", { status: response.status, body: await response.text() });
    } catch (err) {
      await window.__sweetview_rpc("report", { error: String(err.stack || err) });
    }
  })();
`;

let report: Record<string, unknown> | undefined;
let pending = false;
let streamEof = false;
let timedOut = false;
let escaped = false;
const app = await createApp<{
  report: [Record<string, unknown>, void];
  iframeEscaped: [null, void];
  streamFirstReadAfterEof: [null, boolean];
}, { pending: null; streamEof: null }>({
  assets: { "index.html": new Blob([`<!doctype html><body><script>${script}</script>`]), "asset.txt": new Blob(["static asset"]) },
  worker: mode === "sync" ? undefined : "./request-handler.worker.ts",
  onRequest: mode === "sync" ? () => Promise.reject(new Error("Async handler")) as unknown as NativeResponse : "worker",
  allowExternalDrop: false,
  ringBytes: 4096,
  readyTimeoutMs: 12_000,
  onReadyTimeout: () => {
    timedOut = true;
    app.quit();
  },
  uiMethods: {
    iframeEscaped: () => { escaped = true; },
    streamFirstReadAfterEof: () => streamEof,
    report: (value: Record<string, unknown>) => {
      report = value;
      if (!isWorkerCase || pending || value.error) app.quit();
    },
  },
});
app.onEvent(({ name }) => {
  if (name === "streamEof") streamEof = true;
  if (name === "pending") {
    pending = true;
    if (report) app.quit();
  }
});

try {
  app.run();
  console.log("RESULT " + JSON.stringify({ report, pending, timedOut, escaped, assetOrigin: ASSET_ORIGIN, framesOrigin: FRAMES_ORIGIN }));
} finally {
  app.dispose();
}
