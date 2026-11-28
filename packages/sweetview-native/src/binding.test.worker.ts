// Worker side of binding.test.ts: loads the binding a second time, on a thread that is not the UI thread.

// The test process's binding is @n1h/sweetview's (bunfig.toml): a worker loads the same one (D50).
import "../../sweetview/src/binding";
import { binding } from "./binding";
import { Ring } from "../../sweetview/src/ring";
import { pureAnswers } from "../test/pure-answers";

declare const self: Worker;

type Command =
  | { kind: "probe" }
  | { kind: "public" }
  | { kind: "pure"; file: string }
  | { kind: "write"; ring: SharedArrayBuffer; token: number; text: string };

self.onmessage = async (event: MessageEvent<Command>) => {
  const command = event.data;
  const native = binding();
  if (command.kind === "pure") {
    self.postMessage({ kind: "pure", isUiThread: native.isUiThread(), answers: await pureAnswers(command.file) });
    return;
  }
  if (command.kind === "public") {
    // The public calls an application makes, from a Worker: windows, screens, the tray and menus.
    const pub = await import("./index");
    const refused: Record<string, string> = {};
    const calls: Record<string, () => unknown> = {
      "new Window": () => new pub.Window({ title: "worker window" }),
      "Window.fromHandle": () => pub.Window.fromHandle(1n),
      "Screen.all": () => pub.Screen.all(),
      "Screen.primary": () => pub.Screen.primary(),
      "Screen.at": () => pub.Screen.at({ x: 0, y: 0 }),
      "Screen.cursor": () => pub.Screen.cursor(),
      createTray: () => pub.createTray({ tooltip: "worker tray" }),
      // A non-zero owner: a null one is refused before the thread is looked at.
      "Menu.popup": () => pub.Menu.popup(1n, [{ label: "worker item" }]),
    };
    for (const [name, call] of Object.entries(calls)) {
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
