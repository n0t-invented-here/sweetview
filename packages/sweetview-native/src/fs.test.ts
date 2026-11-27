import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllFileHandles, closeFileHandle, openFileHandle, readFileBytes, readFileChunk, readTextFile } from "./index";

describe("native file access", () => {
  let folder: string;
  let file: string;
  const text = "pâté 🥐";
  const bytes = Buffer.from(text, "utf8");

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "sweetview-files-"));
    file = join(folder, "sample.txt");
    writeFileSync(file, bytes);
  });

  afterEach(() => {
    closeAllFileHandles();
    rmSync(folder, { recursive: true, force: true });
  });

  test("reads small text and bounded binary data with byte-based limits", async () => {
    expect(await readTextFile(file)).toBe(text);
    expect(await readTextFile(file, { encoding: "hex" })).toBe(bytes.toString("hex"));
    expect(await readFileBytes(file, { maxBytes: bytes.length })).toEqual(bytes);
    await expect(readTextFile(file, { maxBytes: bytes.length - 1 })).rejects.toThrow(/exceeds maxBytes/);
    await expect(readFileBytes(file, { maxBytes: 0 })).rejects.toThrow(/exceeds maxBytes/);
    await expect(readFileBytes(file, { maxBytes: NaN })).rejects.toThrow(/maxBytes/);
    await expect(readFileBytes(folder)).rejects.toThrow();
    writeFileSync(file, "");
    expect(await readTextFile(file, { maxBytes: 0 })).toBe("");
  });

  test("streams positional chunks, trims short reads, and marks exact and past-end EOF", () => {
    const { handleId, size } = openFileHandle(file);
    expect(size).toBe(bytes.length);
    expect(readFileChunk(handleId, 0, 2)).toEqual({ data: new Uint8Array(bytes.subarray(0, 2)), bytesRead: 2, eof: false });
    expect(readFileChunk(handleId, 2, size - 2)).toEqual({ data: new Uint8Array(bytes.subarray(2)), bytesRead: size - 2, eof: true });
    expect(readFileChunk(handleId, size - 1, 8).bytesRead).toBe(1);
    expect(readFileChunk(handleId, size + 10, 8)).toEqual({ data: new Uint8Array(), bytesRead: 0, eof: true });
    expect(() => readFileChunk(handleId, -1, 1)).toThrow(/offset/);
    expect(() => readFileChunk(handleId, 0.5, 1)).toThrow(/offset/);
    expect(() => readFileChunk(handleId, 0, 0)).toThrow(/length/);
    expect(() => readFileChunk(handleId, 0, 16 * 1024 * 1024 + 1)).toThrow(/length/);
    closeFileHandle(handleId);
    closeFileHandle(handleId);
    expect(() => readFileChunk(handleId, 0, 1)).toThrow(/invalid file handle/);
  });

  test("closes all open handles and observes size changes on an open file", () => {
    const first = openFileHandle(file);
    const second = openFileHandle(file);
    expect(first.handleId).not.toBe(second.handleId);
    writeFileSync(file, "a");
    expect(readFileChunk(first.handleId, 0, 1).eof).toBe(true);
    closeAllFileHandles();
    closeAllFileHandles();
    for (const { handleId } of [first, second]) {
      expect(() => readFileChunk(handleId, 0, 1)).toThrow(/invalid file handle/);
    }
  });
});
