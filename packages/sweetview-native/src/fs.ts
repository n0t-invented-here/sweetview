import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

const MiB = 1024 * 1024;
const maxChunkBytes = 16 * MiB;
// Opening a POSIX FIFO must not block before we can reject it with fstat.
const readOnly = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
const handles = new Map<number, number>();
let nextHandleId = 0;

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("sweetview: maxBytes must be a non-negative safe integer");
  }
  const file = await open(path, readOnly);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`sweetview: expected a regular file at ${path}`);
    const tooLarge = () => new RangeError(`sweetview: ${path} exceeds maxBytes (${maxBytes})`);
    if (info.size > maxBytes) throw tooLarge();

    // Enforce the limit while reading too, in case the same file grows after stat.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(maxBytes - total + 1, 64 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maxBytes) throw tooLarge();
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

/** Reads a regular text file. Defaults to UTF-8 and a 4 MiB limit. */
export async function readTextFile(path: string, options: { maxBytes?: number; encoding?: BufferEncoding } = {}): Promise<string> {
  return (await readBounded(path, options.maxBytes ?? 4 * MiB)).toString(options.encoding ?? "utf8");
}

/** Reads a regular binary file. Defaults to a 32 MiB limit. */
export async function readFileBytes(path: string, options: { maxBytes?: number } = {}): Promise<Uint8Array> {
  return readBounded(path, options.maxBytes ?? 32 * MiB);
}

/** Opens a regular file for positional reads using an opaque handle ID. */
export function openFileHandle(path: string): { handleId: number; size: number } {
  const fd = openSync(path, readOnly);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`sweetview: expected a regular file at ${path}`);
    const handleId = ++nextHandleId;
    handles.set(handleId, fd);
    return { handleId, size: info.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Reads up to 16 MiB from a byte offset without advancing a shared cursor. */
export function readFileChunk(handleId: number, offset: number, length: number): { data: Uint8Array; bytesRead: number; eof: boolean } {
  const fd = handles.get(handleId);
  if (fd === undefined) throw new Error(`sweetview: invalid file handle ${handleId}`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("sweetview: offset must be a non-negative safe integer");
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxChunkBytes) {
    throw new RangeError("sweetview: length must be a positive integer of at most 16 MiB");
  }
  const buffer = new Uint8Array(length);
  const bytesRead = readSync(fd, buffer, 0, length, offset);
  const eof = bytesRead === 0 || bytesRead >= fstatSync(fd).size - offset;
  return { data: buffer.subarray(0, bytesRead), bytesRead, eof };
}

export function closeFileHandle(handleId: number): void {
  const fd = handles.get(handleId);
  if (fd === undefined) return;
  handles.delete(handleId);
  closeSync(fd);
}

export function closeAllFileHandles(): void {
  const errors: unknown[] = [];
  for (const handleId of handles.keys()) {
    try {
      closeFileHandle(handleId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "sweetview: could not close all file handles");
}
