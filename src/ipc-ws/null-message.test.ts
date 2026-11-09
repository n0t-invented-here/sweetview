import { expect, test } from "bun:test";
import { defineService } from "../ipc";
import { wsHost } from "./server";

// A client can send any text; a JSON document that is not an object (`null`, a number, a string) must be ignored, not crash the host.
test("non-object JSON messages are ignored and the socket keeps working", async () => {
  const host = wsHost(defineService<{ ping: [void, "pong"] }, {}>(() => ({ methods: { ping: () => "pong" } })));
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (host.upgrade(req, srv) ? undefined : new Response("no", { status: 400 })),
    websocket: host.websocket,
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send("null");
    ws.send("42");
    ws.send('"text"');
    ws.send("[]");
    ws.send(JSON.stringify({ kind: "call", seq: "1", method: "ping", params: undefined }));
    const reply = await new Promise<string>((resolve) => (ws.onmessage = (e) => resolve(String(e.data))));
    expect(JSON.parse(reply)).toMatchObject({ kind: "reply", seq: "1", ok: true, result: "pong" });
    ws.close();
  } finally {
    host.close();
    server.stop(true);
  }
});
