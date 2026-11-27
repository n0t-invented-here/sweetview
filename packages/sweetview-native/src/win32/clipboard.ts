// Windows clipboard text through the native binding: CF_UNICODETEXT, opened
// up to 5 times 5 ms apart, written through a hidden owner window of its own.

import { binding } from "../binding";

export function readText(): string | null {
  return binding().clipboardReadText() ?? null;
}

export function writeText(text: string): void {
  binding().clipboardWriteText(text);
}

export function clear(): void {
  binding().clipboardClear();
}
