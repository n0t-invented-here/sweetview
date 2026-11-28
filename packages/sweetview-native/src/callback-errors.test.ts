// onCallbackError and reportCallbackError, without a window: what a catch at a callback boundary
// does with and without a listener. The kinds, run from their real callbacks, are in
// callbacks.test.ts ("onCallbackError") and its fixture test/fixtures/callback-errors.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { kindOfBindingCallback, onCallbackError, reportCallbackError, type CallbackErrorSource } from "./callback-errors";

/** Collects what console.error is given until `restore()`. */
function captureErrors() {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void calls.push(args);
  return { calls, restore: () => void (console.error = original) };
}

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});
const listen = (handler: Parameters<typeof onCallbackError>[0]) => offs.push(onCallbackError(handler));

describe("reportCallbackError", () => {
  test("with no listener, a catch prints exactly what it printed before, with the original value", () => {
    const log = captureErrors();
    const thrown = { not: "an error" };
    try {
      reportCallbackError("tray.onClick", thrown, "sweetview: message window handler threw:");
      reportCallbackError("uiMethods", new Error("silent"), null, "settings.save");
      reportCallbackError("worker", new Error("x"), () => console.error("sweetview: the worker sent a message that could not be deserialized"));
    } finally {
      log.restore();
    }
    expect(log.calls).toEqual([["sweetview: message window handler threw:", thrown], ["sweetview: the worker sent a message that could not be deserialized"]]);
  });

  test("with a listener, it is told instead, with an Error and the source; a thrown non-error is wrapped with the value as its cause", () => {
    const told: { error: Error; source: CallbackErrorSource }[] = [];
    listen((error, source) => void told.push({ error, source }));
    const log = captureErrors();
    const original = new TypeError("original");
    try {
      reportCallbackError("window.onClose", original, "sweetview: onClose handler threw:");
      reportCallbackError("deferredUiMethods", "a string", null, "folder.pick");
    } finally {
      log.restore();
    }
    expect(log.calls).toEqual([]);
    expect(told[0]!.error).toBe(original);
    expect(told[0]!.source).toEqual({ kind: "window.onClose" });
    expect(told[1]!.error).toBeInstanceOf(Error);
    expect(told[1]!.error.message).toBe("a string");
    expect(told[1]!.error.cause).toBe("a string");
    expect(told[1]!.source).toEqual({ kind: "deferredUiMethods", name: "folder.pick" });
  });

  test("a listener that throws is caught: Sweetview prints its own line and the listener's error, and the next listener still hears", () => {
    const next: string[] = [];
    listen(() => {
      throw new Error("listener boom");
    });
    listen((error, { kind }) => void next.push(`${kind}: ${error.message}`));
    const log = captureErrors();
    const original = new Error("handler boom");
    try {
      expect(() => reportCallbackError("timeout", original, "sweetview: message window handler threw:")).not.toThrow();
      expect(() => reportCallbackError("onRequest", new Error("silent one"), null)).not.toThrow();
    } finally {
      log.restore();
    }
    expect(next).toEqual(["timeout: handler boom", "onRequest: silent one"]);
    expect(log.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : a)))).toEqual([
      ["sweetview: message window handler threw:", "handler boom"],
      ["sweetview: an onCallbackError handler threw:", "listener boom"],
      ["sweetview: onRequest threw:", "silent one"],
      ["sweetview: an onCallbackError handler threw:", "listener boom"],
    ]);
  });

  test("removing the last listener puts the lines back; a listener added twice is one listener", () => {
    let calls = 0;
    const handler = () => void calls++;
    const offA = onCallbackError(handler);
    const offB = onCallbackError(handler);
    reportCallbackError("deferred", new Error("one"), "sweetview: UI dispatch failed:");
    offA();
    offB();
    const log = captureErrors();
    try {
      reportCallbackError("deferred", new Error("two"), "sweetview: UI dispatch failed:");
    } finally {
      log.restore();
    }
    expect(calls).toBe(1);
    expect(log.calls.map((args) => [args[0], (args[1] as Error).message])).toEqual([["sweetview: UI dispatch failed:", "two"]]);
  });

  test("the binding's names for its callbacks are the public kinds; one with no public counterpart is internal", () => {
    expect(kindOfBindingCallback("a native interval")).toBe("interval");
    expect(kindOfBindingCallback("a tray menu handler")).toBe("menu.click");
    expect(kindOfBindingCallback("a drain function")).toBe("worker");
    expect(kindOfBindingCallback("a tab frame's activation listener")).toBe("internal");
  });
});
