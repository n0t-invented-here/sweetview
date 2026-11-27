// A Worker of fixtures/app.ts: `Clipboard` is a UI-thread call, so it throws here.
import { Clipboard } from "@n1h/sweetview-native";

declare const self: Worker;
let message: string;
try {
  Clipboard.readText();
  message = "no error";
} catch (err) {
  message = (err as Error).message;
}
self.postMessage(message);
