// Unified custom URL scheme registration, single-instance lock & handoff, and
// activation URL buffering pipeline. Cold-launch and early warm-launch URLs are
// queued until signalReady() is called, then drained in FIFO order.

import { validateUrlScheme, type AppIdentity } from "@n1h/sweetview-settings";
import { reportCallbackError } from "./callback-errors";
import { releaseAtEnd } from "./lifetime";
import { backend } from "./platform";

export type RegisterUrlSchemeOptions = {
  identity?: AppIdentity;
  /** Human-readable app name for Windows protocol description. */
  appName?: string;
  /** Executable path launched by the protocol. Default `process.execPath`. */
  executablePath?: string;
  /** Windows `DefaultIcon` registry value. Default `"<executablePath>,0"`. */
  iconPath?: string;
  /** Custom Windows command line. Default `"\"<executablePath>\" \"%1\""`. */
  command?: string;
};

export type SecondInstanceEvent = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly url?: string;
};

/** Validates JSON from the native single-instance handoff. */
export function parseSecondInstanceEvent(raw: string): SecondInstanceEvent | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (payload && typeof payload === "object"
    && "args" in payload && Array.isArray(payload.args)
    && payload.args.every((arg: unknown) => typeof arg === "string")
    && "cwd" in payload && typeof payload.cwd === "string"
    && (!("url" in payload) || typeof payload.url === "string")) {
    return payload as SecondInstanceEvent;
  }
  return undefined;
}

export type SingleInstanceOptions = {
  /** Unique application identifier (e.g. `"com.example.my-app"`). Required unless `identity` is provided. */
  appId?: string;
  /** Optional unified app identity supplying `appId` and `urlSchemes`. */
  identity?: AppIdentity;
  /** URL schemes to extract from launch argv. Defaults to `identity.urlSchemes`. */
  urlSchemes?: readonly string[];
  /** Override process argv passed in the handoff payload (useful for testing). */
  args?: readonly string[];
  /** Called on the primary instance whenever a secondary instance starts and hands off its args/URL. */
  onSecondInstance?: (event: SecondInstanceEvent) => void;
};

export type SingleInstanceLock = {
  readonly isPrimary: boolean;
  /**
   * Secondary instance only: true when the `{ args, cwd, url }` payload was
   * delivered over the native transport (Windows `WM_COPYDATA` returned
   * success, macOS `CFMessagePortSendRequest` succeeded). It reports transport
   * delivery, not that the primary's `onSecondInstance` handler ran or
   * succeeded. On macOS it is also true when this process already holds the
   * lock for the same app ID: the payload is then handed to this process's
   * own `onSecondInstance` handler in-process, with no transport involved.
   * Always false on the primary instance.
   */
  readonly handedOff: boolean;
  dispose(): void;
};

type Backend = {
  registerUrlScheme(scheme: string, options?: RegisterUrlSchemeOptions): void;
  unregisterUrlScheme(scheme: string): void;
  installUrlEventHandler(onUrl: (url: string) => void): void;
  acquireSingleInstance(params: {
    appId: string;
    payload: SecondInstanceEvent;
    onSecondInstance: (event: SecondInstanceEvent) => void;
  }): Promise<SingleInstanceLock>;
};

const impl = backend<Backend>(
  () => require("./win32/activation"),
  () => require("./darwin/activation"),
);

// ---- unified URL buffering pipeline ---------------------------------------------

const urlListeners = new Set<(url: string) => void>();
const bufferedUrls: string[] = [];
let activationReady = false;
let nativeUrlHookInstalled = false;

function dispatchUrl(url: string): void {
  if (!activationReady) {
    bufferedUrls.push(url);
    return;
  }
  for (const fn of [...urlListeners]) {
    try {
      fn(url);
    } catch (err) {
      reportCallbackError("onOpenUrl", err, "sweetview: onOpenUrl handler threw:");
    }
  }
}

/** Extracts the first argument matching one of `schemes` (or any custom `scheme://...` URL when `schemes` is omitted). */
export function extractUrlFromArgs(args: readonly string[], schemes?: readonly string[]): string | undefined {
  const normalized = schemes && schemes.length > 0 ? new Set(schemes.map(validateUrlScheme)) : undefined;
  for (const arg of args) {
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(arg);
    if (!m) continue;
    const scheme = m[1]!.toLowerCase();
    if (normalized) {
      if (normalized.has(scheme)) return arg;
    } else if (scheme !== "http" && scheme !== "https" && scheme !== "file") {
      return arg;
    }
  }
  return undefined;
}

/**
 * Registers a custom URL scheme for the current user.
 * - Windows: writes `HKCU\Software\Classes\<scheme>` (no admin/UAC required).
 * - macOS: only validates scheme syntax. Launch Services has no per-user
 *   runtime registry an unbundled process can write to: it reads
 *   `CFBundleURLTypes` from the signed `.app` bundle's `Info.plist` when the
 *   bundle is registered (first launch, or when it is copied into place).
 *   Declare schemes at build time with `makeMacApp({ urlSchemes })`.
 */
export function registerUrlScheme(scheme: string, options?: RegisterUrlSchemeOptions): void {
  impl().registerUrlScheme(scheme, options);
}

/**
 * Removes a user-level custom URL scheme registration.
 * - Windows: deletes `HKCU\Software\Classes\<scheme>`.
 * - macOS: only validates scheme syntax. The scheme lives in the `.app`
 *   bundle's `Info.plist` `CFBundleURLTypes` (`makeMacApp({ urlSchemes })`),
 *   so it is removed by rebuilding the bundle without it, not at run time.
 */
export function unregisterUrlScheme(scheme: string): void {
  impl().unregisterUrlScheme(scheme);
}

/**
 * Subscribes to custom URL activation events (cold launch, warm launch via
 * `singleInstance`, or macOS `kAEGetURL` Apple Events). Events arriving before
 * `signalReady()` are buffered and delivered in order once `signalReady()` runs.
 */
export function onOpenUrl(handler: (url: string) => void): () => void {
  if (!nativeUrlHookInstalled && (process.platform === "win32" || process.platform === "darwin")) {
    nativeUrlHookInstalled = true;
    impl().installUrlEventHandler(dispatchUrl);
  }
  urlListeners.add(handler);
  return () => urlListeners.delete(handler);
}

/**
 * Marks the application ready to process activation events and drains any
 * buffered URLs in FIFO order. Also invoked automatically when a page calls
 * `signalReady()` from `@n1h/sweetview/page`.
 */
export function signalReady(): void {
  if (activationReady) return;
  activationReady = true;
  while (bufferedUrls.length > 0) {
    const next = bufferedUrls.shift()!;
    dispatchUrl(next);
  }
}

/** Enqueues an activation URL into the pipeline (for startup argv ingestion and tests). */
export function emitActivationUrl(url: string): void {
  dispatchUrl(url);
}

/** Internal test helper to reset the activation readiness state between isolated unit tests. */
export function _resetActivationForTest(): void {
  activationReady = false;
  bufferedUrls.length = 0;
  urlListeners.clear();
}

/**
 * Acquires the single-instance lock for `appId` (or `identity.appId`).
 * - Primary instance: installs the native handoff listener (Windows `WM_COPYDATA`, macOS `CFMessagePort`) and ingests any cold-launch URL in argv into the `onOpenUrl` pipeline.
 * - Secondary instance: forwards `{ args, cwd, url }` to the primary instance and returns `{ isPrimary: false, handedOff }`.
 */
export async function singleInstance(options: SingleInstanceOptions): Promise<SingleInstanceLock> {
  const appId = (options.appId ?? options.identity?.appId ?? "").trim();
  if (!appId) throw new Error("sweetview: singleInstance requires appId or identity");
  const schemes = options.urlSchemes ?? options.identity?.urlSchemes;
  const args = options.args ?? process.argv.slice(1);
  const url = extractUrlFromArgs(args, schemes);

  if (!nativeUrlHookInstalled && (process.platform === "win32" || process.platform === "darwin")) {
    nativeUrlHookInstalled = true;
    impl().installUrlEventHandler(dispatchUrl);
  }

  const lock = await impl().acquireSingleInstance({
    appId,
    payload: { args, cwd: process.cwd(), ...(url ? { url } : {}) },
    onSecondInstance(event) {
      if (event.url) dispatchUrl(event.url);
      if (options.onSecondInstance) {
        try {
          options.onSecondInstance(event);
        } catch (err) {
          reportCallbackError("singleInstance.onSecondInstance", err, "sweetview: onSecondInstance handler threw:");
        }
      }
    },
  });

  if (lock.isPrimary && url) {
    dispatchUrl(url);
  }
  // A primary's lock is released when the application ends (see `run()`), so the next launch is the primary.
  const unregister = releaseAtEnd("lock", () => lock.dispose());
  return {
    isPrimary: lock.isPrimary,
    handedOff: lock.handedOff,
    dispose() {
      unregister();
      lock.dispose();
    },
  };
}
