// For webview-serving.ts "teardown-worker-race": streams chunks into one
// request and answers another as fast as it can, from a Worker, while the UI
// thread destroys the webview. Records each result code in order.

import { beginWebviewResponse, completeWebviewRequest, WebviewError, writeWebviewResponseChunk } from "../../../sweetview/src/raw-webview";

declare var self: Worker;

const codes: { stream: number[]; complete: number[] } = { stream: [], complete: [] };
let stopped = false;

const codeOf = (fn: () => void) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return e instanceof WebviewError ? e.code : -999;
  }
};

self.onmessage = async (e: MessageEvent) => {
  const data = e.data as { handle?: number; id?: bigint; stream?: boolean; stop?: boolean };
  if (data.stop) {
    stopped = true;
    postMessage(codes);
    return;
  }
  const { handle, id, stream } = data as { handle: number; id: bigint; stream: boolean };
  if (stream) {
    codes.stream.push(codeOf(() => beginWebviewResponse(handle, id, { headers: { "Content-Type": "text/plain" } })));
    while (!stopped && codes.stream.length < 100_000) {
      codes.stream.push(codeOf(() => writeWebviewResponseChunk(handle, id, "chunk ")));
      if (codes.stream.length % 50 === 0) await Bun.sleep(1);
    }
  } else {
    // Answering the same request again and again: the first is accepted, the
    // rest do nothing, and once the webview is gone each is refused.
    while (!stopped && codes.complete.length < 100_000) {
      codes.complete.push(codeOf(() => completeWebviewRequest(handle, id, { body: "x" })));
      if (codes.complete.length % 50 === 0) await Bun.sleep(1);
    }
  }
};

postMessage("ready");
