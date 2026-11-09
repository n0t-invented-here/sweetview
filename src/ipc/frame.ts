// Wire frames. Every transport (WebSocket, the sweetview ring, memory) carries
// exactly these, as JSON. The service never sees a frame; hosts do the
// seq <-> promise correlation.

/** Page -> backend. `seq: null` means fire and forget: no reply frame comes back. */
export type CallFrame = { kind: "call"; seq: string | null; method: string; params: unknown };

/** Backend -> page, answering one call. `error` is a user-safe message. */
export type ReplyFrame =
  | { kind: "reply"; seq: string; ok: true; result: unknown }
  | { kind: "reply"; seq: string; ok: false; error: string };

/** Backend -> page, unsolicited. */
export type EventFrame = { kind: "event"; name: string; payload: unknown };

export type Frame = CallFrame | ReplyFrame | EventFrame;
