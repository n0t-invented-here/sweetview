// The macOS seams of this package, decided on any machine: until the macOS goal of the Rust
// rewrite, macOS keeps the path it had at the tag `pre-rust-rewrite`
// (rust-rewrite/HANDOFF-macos.md, section 8). `process.platform` is set around each call;
// no worker, window or webview is made.

import { afterEach, describe, expect, test } from "bun:test";
import { unrefWorker } from "./app";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const as = (name: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value: name });
afterEach(() => Object.defineProperty(process, "platform", platform));

const fakeWorker = () => {
  const worker = { unrefs: 0, unref() { worker.unrefs++; } };
  return worker;
};

describe("a webview's worker", () => {
  test("keeps its reference on macOS, as at the tag", () => {
    const worker = fakeWorker();
    as("darwin");
    unrefWorker(worker as unknown as Worker);
    expect(worker.unrefs).toBe(0);
  });

  test("is unref'd on Windows", () => {
    const worker = fakeWorker();
    as("win32");
    unrefWorker(worker as unknown as Worker);
    expect(worker.unrefs).toBe(1);
  });

  test("no worker is nothing to do", () => {
    as("win32");
    expect(() => unrefWorker(undefined)).not.toThrow();
  });
});
