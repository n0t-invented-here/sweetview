// Wire frames. Every transport (WebSocket, the sweetview ring, memory) carries
// these as JSON. The service never sees a frame; hosts do the seq <-> promise
// correlation. Large worker->UI frames (> ring capacity) are split into
// ChunkFrame pieces and reassembled on the UI thread by createFrameAssembler().

/** Page -> backend. `seq: null` means fire and forget: no reply frame comes back. */
export type CallFrame = { kind: "call"; seq: string | null; method: string; params: unknown };

/** Backend -> page, answering one call. `error` is a user-safe message. */
export type ReplyFrame =
  | { kind: "reply"; seq: string; ok: true; result: unknown }
  | { kind: "reply"; seq: string; ok: false; error: string };

/** Backend -> page, unsolicited. */
export type EventFrame = { kind: "event"; name: string; payload: unknown };

/** Worker -> UI chunk carrying a base64 slice of an oversized ReplyFrame or EventFrame. */
export type ChunkFrame = { kind: "chunk"; id: number; index: number; total: number; data: string };

export type Frame = CallFrame | ReplyFrame | EventFrame;
export type WireFrame = Frame | ChunkFrame;

/** Decodes base64 to UTF-8 bytes without depending on Node Buffer (browser-safe). */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Reassembles ChunkFrame sequences back into complete Frame objects.
 * Non-chunk frames pass straight through.
 */
export function createFrameAssembler(): {
  push(frame: WireFrame): Frame | null;
  clear(): void;
} {
  const pending = new Map<number, { total: number; received: number; parts: string[] }>();
  const decoder = new TextDecoder();

  return {
    push(frame: WireFrame): Frame | null {
      if (frame.kind !== "chunk") return frame;
      if (frame.total <= 0 || frame.index < 0 || frame.index >= frame.total) return null;
      let entry = pending.get(frame.id);
      if (!entry) {
        entry = { total: frame.total, received: 0, parts: new Array<string>(frame.total) };
        pending.set(frame.id, entry);
      }
      if (entry.parts[frame.index] === undefined) entry.received++;
      entry.parts[frame.index] = frame.data;
      if (entry.received < entry.total) return null;
      pending.delete(frame.id);
      const joined = entry.parts.join("");
      const json = decoder.decode(base64ToBytes(joined));
      return JSON.parse(json) as Frame;
    },
    clear() {
      pending.clear();
    },
  };
}
