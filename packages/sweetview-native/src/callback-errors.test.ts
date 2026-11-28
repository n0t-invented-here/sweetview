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
      reportCallbackError("internal", new Error("silent"), null, "a binding");
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
      reportCallbackError("internal", "a string", null, "a deferred job");
    } finally {
      log.restore();
    }
    expect(log.calls).toEqual([]);
    expect(told[0]!.error).toBe(original);
    expect(told[0]!.source).toEqual({ kind: "window.onClose" });
    expect(told[1]!.error).toBeInstanceOf(Error);
    expect(told[1]!.error.message).toBe("a string");
    expect(told[1]!.error.cause).toBe("a string");
    expect(told[1]!.source).toEqual({ kind: "internal", name: "a deferred job" });
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
      expect(() => reportCallbackError("tray.onClick", original, "sweetview: message window handler threw:")).not.toThrow();
      expect(() => reportCallbackError("internal", new Error("silent one"), null)).not.toThrow();
    } finally {
      log.restore();
    }
    expect(next).toEqual(["tray.onClick: handler boom", "internal: silent one"]);
    expect(log.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : a)))).toEqual([
      ["sweetview: message window handler threw:", "handler boom"],
      ["sweetview: an onCallbackError handler threw:", "listener boom"],
      ["sweetview: internal threw:", "silent one"],
      ["sweetview: an onCallbackError handler threw:", "listener boom"],
    ]);
  });

  test("removing the last listener puts the lines back", () => {
    let calls = 0;
    const handler = () => void calls++;
    const offA = onCallbackError(handler);
    const offB = onCallbackError(handler);
    reportCallbackError("internal", new Error("one"), "sweetview: UI dispatch failed:");
    offA();
    offB();
    const log = captureErrors();
    try {
      reportCallbackError("internal", new Error("two"), "sweetview: UI dispatch failed:");
    } finally {
      log.restore();
    }
    expect(calls).toBe(2); // two registrations of the same function: each is called
    expect(log.calls.map((args) => [args[0], (args[1] as Error).message])).toEqual([["sweetview: UI dispatch failed:", "two"]]);
  });

  test("the binding's names for its callbacks are the public kinds; one with no public counterpart is internal", () => {
    expect(kindOfBindingCallback("a native interval")).toBe("internal");
    expect(kindOfBindingCallback("a tray menu handler")).toBe("menu.click");
    expect(kindOfBindingCallback("a drain function")).toBe("worker");
    expect(kindOfBindingCallback("a tab frame's activation listener")).toBe("internal");
  });
});

describe("the reporter is not an entry point", () => {
  test("no entry point of the package lets an application fabricate a fault: ./internal does not export reportCallbackError", async () => {
    const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as { exports: Record<string, string> };
    const offering: string[] = [];
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target !== "string" || subpath.includes("darwin")) continue;
      const mod = (await import(new URL(`../${target}`, import.meta.url).href)) as Record<string, unknown>;
      for (const name of ["reportCallbackError", "kindOfBindingCallback"]) if (name in mod) offering.push(`${subpath}: ${name}`);
    }
    expect(offering).toEqual([]);
  });
});

describe("reporting never throws (review F2, N1)", () => {
  const unreadable = () => [
    Object.create(null) as object, // String() throws: no toString
    new Proxy({}, {
      get() {
        throw new Error("get trap");
      },
      getPrototypeOf() {
        throw new Error("getPrototypeOf trap");
      },
    }),
  ];

  test("with a listener, a thrown value that cannot be converted or inspected is reported, and reporting returns", () => {
    const told: { message: string; cause: unknown }[] = [];
    listen((error) => void told.push({ message: error.message, cause: error.cause }));
    const values = unreadable();
    for (const value of values) expect(() => reportCallbackError("onOpenUrl", value, "sweetview: onOpenUrl handler threw:")).not.toThrow();
    expect(told.length).toBe(2);
    expect(told[0]!.cause).toBe(values[0]);
    expect(told[1]!.cause).toBe(values[1]);
    for (const { message } of told) expect(typeof message).toBe("string");
  });

  test("an onOpenUrl listener that throws such a value does not stop the next one", async () => {
    const { onOpenUrl, signalReady, emitActivationUrl, _resetActivationForTest } = await import("./activation");
    _resetActivationForTest();
    listen(() => {});
    const seen: string[] = [];
    const offFirst = onOpenUrl(() => {
      throw Object.create(null);
    });
    const offSecond = onOpenUrl((url) => void seen.push(url));
    try {
      signalReady();
      expect(() => emitActivationUrl("svtest://after")).not.toThrow();
    } finally {
      offFirst();
      offSecond();
      _resetActivationForTest();
    }
    expect(seen).toEqual(["svtest://after"]);
  });
});

describe("listeners changed during a dispatch (review N8)", () => {
  test("a listener that removes itself and another: every listener set when the fault came hears it; the next fault only the one left", () => {
    const heard: string[] = [];
    let offB: () => void = () => {};
    const offA = onCallbackError((error) => {
      heard.push(`a: ${error.message}`);
      offA();
      offB();
    });
    offB = onCallbackError((error) => void heard.push(`b: ${error.message}`));
    listen((error) => void heard.push(`c: ${error.message}`));
    reportCallbackError("internal", new Error("first"), "sweetview: UI dispatch failed:");
    reportCallbackError("internal", new Error("second"), "sweetview: UI dispatch failed:");
    expect(heard).toEqual(["a: first", "b: first", "c: first", "c: second"]);
  });
});

describe("an unsubscribe removes its own registration, once (review 2, item 7)", () => {
  test("an old unsubscribe called again after the same function is registered anew leaves the new registration", () => {
    const heard: string[] = [];
    const fn = (error: Error) => void heard.push(error.message);
    const offOld = onCallbackError(fn);
    offOld();
    const offNew = onCallbackError(fn);
    offs.push(offNew);
    offOld(); // the registration it made is gone already: this does nothing
    reportCallbackError("internal", new Error("still heard"), "sweetview: UI dispatch failed:");
    expect(heard).toEqual(["still heard"]);
  });

  test("the same function registered twice is two registrations: each unsubscribe removes one", () => {
    const heard: string[] = [];
    const fn = (error: Error) => void heard.push(error.message);
    const offA = onCallbackError(fn);
    const offB = onCallbackError(fn);
    offs.push(offB);
    reportCallbackError("internal", new Error("both"), "sweetview: UI dispatch failed:");
    offA();
    reportCallbackError("internal", new Error("one left"), "sweetview: UI dispatch failed:");
    expect(heard).toEqual(["both", "both", "one left"]);
  });
});

describe("application code run while a fault is reported (review 2, item 2)", () => {
  test("a listener added while the thrown value is converted does not hear the fault it was added during", () => {
    const heard: string[] = [];
    listen(() => void heard.push("present"));
    const late = new Proxy({}, {
      getPrototypeOf() {
        offs.push(onCallbackError(() => void heard.push("added during the conversion")));
        return Object.prototype;
      },
    });
    reportCallbackError("internal", late, "sweetview: UI dispatch failed:");
    expect(heard).toEqual(["present"]);
  });

  test("a conversion that reports the same value again ends, and the nested fault is printed, not lost", () => {
    const heard: string[] = [];
    listen(() => void heard.push("delivered"));
    let conversions = 0;
    const recursive: object = new Proxy({}, {
      getPrototypeOf() {
        conversions++;
        // As a callback that runs here and throws the same object would be reported.
        reportCallbackError("window.onResize", recursive, "sweetview: onResize handler threw:");
        return Object.prototype;
      },
    });
    const log = captureErrors();
    try {
      expect(() => reportCallbackError("window.onResize", recursive, "sweetview: onResize handler threw:")).not.toThrow();
    } finally {
      log.restore();
    }
    expect(heard).toEqual(["delivered"]);
    expect(conversions).toBeLessThan(10);
    expect(log.calls.some((args) => args[0] === "sweetview: onResize handler threw:" || String(args[0]).startsWith("sweetview: window.onResize threw"))).toBe(true);
  });
});
