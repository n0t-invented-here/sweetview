// The macOS seams of this package, decided on any machine: until the macOS goal of the Rust
// rewrite, macOS keeps the path it had at the tag `pre-rust-rewrite`
// (rust-rewrite/HANDOFF-macos.md, section 8). `process.platform` is set around each call;
// no worker, window or webview is made.

import { afterEach, describe, expect, test } from "bun:test";
import { callEventListeners, printsWorkerFailure, unrefWorker } from "./app";
import { messageOfThrown } from "./thrown-text";

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

// Review round 3's fixes in this package's shared files (D42): macOS runs the tag's code.
describe("the faults of a page's calls and the worker's events", () => {
  const unreadable = () => new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } });

  test("a thrown value is read as at the tag on macOS (a throw included), safely on Windows", () => {
    as("darwin");
    expect(() => messageOfThrown(unreadable())).toThrow("trap");
    as("win32");
    expect(messageOfThrown(unreadable())).toBe("[object Object]");
  });

  test("an onEvent listener's throw leaves the delivery at once on macOS; on Windows the next listener runs", () => {
    const ran: string[] = [];
    const listeners = [() => { throw new Error("first"); }, () => void ran.push("second")];
    as("darwin");
    expect(() => callEventListeners(listeners, "tick", 1, [])).toThrow("first");
    expect(ran).toEqual([]);
    as("win32");
    const errors: unknown[] = [];
    callEventListeners(listeners, "tick", 1, errors);
    expect({ ran, errors: errors.length }).toEqual({ ran: ["second"], errors: 1 });
  });

  test("a worker failure is printed by every path on macOS, by the first on Windows", () => {
    as("darwin");
    expect(printsWorkerFailure(true, false)).toBe(true);
    as("win32");
    expect([printsWorkerFailure(false, false), printsWorkerFailure(true, false), printsWorkerFailure(false, true)]).toEqual([true, false, false]);
  });
});
