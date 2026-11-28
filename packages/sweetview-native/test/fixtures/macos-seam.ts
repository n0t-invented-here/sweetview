// The decisions of the macOS seams, made on any machine: this process says it is macOS
// (`process.platform` is set before anything of the package loads) and stands in a module of
// its own for @n1h/sweetview-webview-bun. Nothing here reaches AppKit or a webview: on macOS
// every call below goes to the stand-in, and the stand-in only records what it was given.
//
//   bun test/fixtures/macos-seam.ts absent   the package is not installed
//   bun test/fixtures/macos-seam.ts fake     the package is the stand-in below
//
// Prints `RESULT <json>`.

const scenario = process.argv[2];
Object.defineProperty(process, "platform", { ...Object.getOwnPropertyDescriptor(process, "platform"), value: "darwin" });

const calls: unknown[][] = [];
const record = (name: string) => (...args: unknown[]) => {
  calls.push([name, ...args.map((a) => (typeof a === "bigint" ? `${a}n` : a))]);
};

Bun.plugin({
  name: "sweetview-webview-bun stand-in",
  setup(build) {
    build.module("@n1h/sweetview-webview-bun", () => {
      if (scenario === "absent") throw new Error("Cannot find package '@n1h/sweetview-webview-bun'");
      class Webview {
        readonly args: unknown[];
        constructor(...args: unknown[]) {
          this.args = args;
          record("Webview")(...args);
        }
      }
      let autoRequest = true;
      return {
        loader: "object",
        exports: {
          Webview,
          completeWebviewRequest: record("completeWebviewRequest"),
          beginWebviewResponse: record("beginWebviewResponse"),
          writeWebviewResponseChunk: record("writeWebviewResponseChunk"),
          endWebviewResponse: record("endWebviewResponse"),
          unload: record("unload"),
          installMouseHook: (handler: unknown) => {
            record("installMouseHook")(typeof handler);
            return { dispose: record("mouseHook.dispose") };
          },
          installKeyboardHook: (handler: unknown) => {
            record("installKeyboardHook")(typeof handler);
            return { dispose: record("keyboardHook.dispose") };
          },
          permissions: {
            needed: (feature: number) => (record("permissions.needed")(feature), [1]),
            status: (permission: number) => (record("permissions.status")(permission), "granted"),
            request: (permission: number) => (record("permissions.request")(permission), "missing"),
            ready(this: { needed(feature: number): number[] }, feature: number) {
              record("permissions.ready")(feature);
              return this.needed(feature).length === 1;
            },
            get autoRequest() {
              return autoRequest;
            },
            set autoRequest(on: boolean) {
              record("permissions.autoRequest=")(on);
              autoRequest = on;
            },
          },
        },
      };
    });
  },
});

const errorOf = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

let imported: string | null = null;
let native: typeof import("../../src/index") | undefined;
let internal: typeof import("../../src/internal") | undefined;
try {
  native = await import("../../src/index");
  internal = await import("../../src/internal");
} catch (err) {
  imported = err instanceof Error ? err.message : String(err);
}

const result: Record<string, unknown> = { platform: process.platform, importError: imported };

if (native && internal) {
  const { RawWebview, SizeHint, installMouseHook, installKeyboardHook, permissions, completeWebviewRequest } = native;
  const size = { width: 300, height: 200, hint: SizeHint.NONE };

  // The release at exit: nothing is registered on macOS and no `exit` listener is added.
  const exitListeners = process.listenerCount("exit");
  let released = 0;
  const unregister = internal.releaseAtEnd("tray", () => void released++);
  internal.releaseAll();
  unregister();
  result.lifetime = { exitListenersAdded: process.listenerCount("exit") - exitListeners, released, macosKeepsTagPath: internal.macosKeepsTagPath() };

  if (scenario === "absent") {
    result.webviewError = errorOf(() => new RawWebview(false, size, 5n));
    result.mouseHookError = errorOf(() => installMouseHook(() => false));
    result.permissionsError = errorOf(() => permissions.status(1));
  } else {
    const fromBigint = new RawWebview(false, size, 0x1234n) as unknown as { args: unknown[] };
    const fromNumber = new RawWebview(true, size, 77) as unknown as { args: unknown[] };
    const noWindow = new RawWebview(false, size, null) as unknown as { args: unknown[] };
    const windowArg = (view: { args: unknown[] }) => ({ type: typeof view.args[2], value: typeof view.args[2] === "bigint" ? String(view.args[2]) : view.args[2] });
    result.webviewWindow = [windowArg(fromBigint), windowArg(fromNumber), windowArg(noWindow)];

    const mouse = installMouseHook(() => false);
    mouse.dispose();
    installKeyboardHook(() => false).dispose();
    permissions.autoRequest = false;
    result.permissions = { status: permissions.status(1), request: permissions.request(2), ready: permissions.ready(0), needed: permissions.needed(1), autoRequest: permissions.autoRequest };
    completeWebviewRequest(9, 3n, { status: 204 });
    result.calls = calls.filter(([name]) => name !== "Webview");

    // onCallbackError: on macOS a listener that is set is not called, and a catch prints what it
    // printed on the main branch. The reporter is no entry point, so it is imported by its path.
    const { reportCallbackError } = await import("../../src/callback-errors");
    const told: string[] = [];
    const printed: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void printed.push(args.map((a) => (a instanceof Error ? a.message : a)));
    const off = native.onCallbackError((error, source) => void told.push(`${source.kind}: ${error.message}`));
    try {
      reportCallbackError("tray.onClick", new Error("mac boom"), "sweetview: message window handler threw:");
      reportCallbackError("window.onClose", new Error("mac close"), "sweetview: onClose handler threw:");
    } finally {
      off();
      console.error = originalError;
    }
    result.callbackErrors = { told, printed };
  }
}

console.log(`RESULT ${JSON.stringify(result)}`);
