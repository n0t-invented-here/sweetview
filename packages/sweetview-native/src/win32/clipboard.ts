import { toArrayBuffer } from "bun:ffi";
import { CF_UNICODETEXT, GMEM_MOVEABLE, kernel32, lastError, user32, wstr } from "./api";
import { ensureWin32Init } from "./init";
import { createMessageWindowRaw } from "./message-window";

function withClipboard<T>(hwnd: bigint, fn: () => T): T {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (user32.OpenClipboard(hwnd) !== 0) {
      try {
        return fn();
      } finally {
        user32.CloseClipboard();
      }
    }
    if (attempt < 4) kernel32.Sleep(5);
  }
  throw new Error(`sweetview: OpenClipboard failed (${lastError()})`);
}

export function readText(): string | null {
  return withClipboard(0n, () => {
    const memory = user32.GetClipboardData(CF_UNICODETEXT);
    if (memory === 0n) return null;
    const address = kernel32.GlobalLock(memory);
    if (!address) throw new Error(`sweetview: GlobalLock failed (${lastError()})`);
    try {
      // GlobalSize bounds the scan. Padding after the terminator is not text.
      const size = Number(kernel32.GlobalSize(memory));
      const data = new Uint16Array(toArrayBuffer(address, 0, size - size % 2));
      const end = data.indexOf(0);
      if (end === -1) throw new Error("sweetview: CF_UNICODETEXT has no NUL terminator");
      return Buffer.from(data.buffer, 0, end * 2).toString("utf16le");
    } finally {
      kernel32.GlobalUnlock(memory);
    }
  });
}

export function writeText(text: string): void {
  // EmptyClipboard assigns the open HWND as owner. NULL cannot own new data.
  ensureWin32Init();
  const owner = createMessageWindowRaw(() => {});
  try {
    withClipboard(owner.hwnd, () => {
      const data = wstr(text);
      const memory = kernel32.GlobalAlloc(GMEM_MOVEABLE, BigInt(data.byteLength));
      if (memory === 0n) throw new Error(`sweetview: GlobalAlloc failed (${lastError()})`);
      let transferred = false;
      try {
        const address = kernel32.GlobalLock(memory);
        if (!address) throw new Error(`sweetview: GlobalLock failed (${lastError()})`);
        try {
          new Uint8Array(toArrayBuffer(address, 0, data.byteLength)).set(data);
        } finally {
          kernel32.GlobalUnlock(memory);
        }
        empty();
        if (user32.SetClipboardData(CF_UNICODETEXT, memory) === 0n) {
          throw new Error(`sweetview: SetClipboardData failed (${lastError()})`);
        }
        transferred = true;
      } finally {
        if (!transferred) kernel32.GlobalFree(memory);
      }
    });
  } finally {
    owner.destroy();
  }
}

function empty(): void {
  if (user32.EmptyClipboard() === 0) throw new Error(`sweetview: EmptyClipboard failed (${lastError()})`);
}

export function clear(): void {
  withClipboard(0n, empty);
}
