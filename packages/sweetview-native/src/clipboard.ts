import { backend } from "./platform";

type ClipboardBackend = {
  readText(): string | null;
  writeText(text: string): void;
  clear(): void;
};

const impl = backend<ClipboardBackend>(
  () => require("./win32/clipboard"),
  () => require("./darwin/clipboard"),
);

/** Synchronous text access to the system clipboard on the UI thread. */
export const Clipboard: ClipboardBackend = {
  readText: () => impl().readText(),
  writeText: (text) => impl().writeText(text),
  clear: () => impl().clear(),
};
