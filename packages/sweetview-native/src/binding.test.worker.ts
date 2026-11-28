// Worker side of binding.test.ts: loads the binding a second time, on a thread that is not the UI thread.

// The test process's binding is @n1h/sweetview's (bunfig.toml): a worker loads the same one (D50).
import "../../sweetview/src/binding";
import { binding } from "./binding";
import { Ring } from "../../sweetview/src/ring";
import { pureAnswers } from "../test/pure-answers";

declare const self: Worker;

type Command =
  | { kind: "probe" }
  | { kind: "pure"; file: string }
  | { kind: "write"; ring: SharedArrayBuffer; token: number; text: string };

self.onmessage = async (event: MessageEvent<Command>) => {
  const command = event.data;
  const native = binding();
  if (command.kind === "pure") {
    self.postMessage({ kind: "pure", isUiThread: native.isUiThread(), answers: await pureAnswers(command.file) });
    return;
  }
  if (command.kind === "probe") {
    const refused: Record<string, string> = {};
    const uiOnly: Record<string, () => unknown> = {
      pumpEvents: () => native.pumpEvents(),
      runLoop: () => native.runLoop(),
      quitLoop: () => native.quitLoop(),
      defer: () => native.defer(() => {}),
      scheduleTimeout: () => native.scheduleTimeout(1, () => {}),
      scheduleInterval: () => native.scheduleInterval(1, () => {}),
      cancelTimeout: () => native.cancelTimeout(1),
      setDrain: () => native.setDrain(9, () => {}),
      isLoopBlocking: () => native.isLoopBlocking(),
    };
    for (const [name, call] of Object.entries(uiOnly)) {
      try {
        call();
        refused[name] = "did not throw";
      } catch (err) {
        refused[name] = (err as Error).message;
      }
    }
    self.postMessage({ kind: "probed", isUiThread: native.isUiThread(), refused });
    return;
  }
  // The transport's worker hop: a frame into the ring, then the wake.
  const ring = new Ring(command.ring);
  ring.write(new TextEncoder().encode(command.text));
  const woke = ring.claimWakeup() ? native.wake(command.token) : true;
  self.postMessage({ kind: "written", woke });
};
