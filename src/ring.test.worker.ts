// Helper for ring.test.ts: writes one 8-byte frame, blocking if the ring is full.
import { Ring } from "./ring";

declare const self: Worker;

self.onmessage = (e: MessageEvent<SharedArrayBuffer>) => {
  new Ring(e.data).write(new Uint8Array(8));
  self.postMessage("written");
};
