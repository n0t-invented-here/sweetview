// Single application identity manifest shared across runtime primitives
// (SettingsStore, singleInstance, registerUrlScheme, Window) and build tools
// (makeMacApp). Zero bun:ffi or webview imports so any build or runtime script
// can import it on any OS.

import { appDataDir } from "./settings-store";

const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/i;

export type AppIdentityIcon = {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
};

export type AppIdentityInput = {
  /** Reverse-DNS identifier, e.g. `"com.example.my-app"`. Used for macOS bundle ID and single-instance lock. */
  appId: string;
  /** Human-readable application name shown in title bars, Finder, menus, and protocol descriptions. */
  appName: string;
  /** Folder name under the OS app-data directory. Defaults to a safe slug derived from `appId`. */
  slug?: string;
  /** Semver version string. Default `"0.1.0"`. */
  version?: string;
  /** Custom URL schemes handled by this application, e.g. `["my-app"]`. */
  urlSchemes?: readonly string[];
  /**
   * Application icon pixels. The only automatic consumer is `new Window({ identity })`
   * on Windows, which uses it as the window icon when `icon` is not given (macOS
   * windows have no per-window icon). Tray icons, `writeIconFiles`, and
   * `makeMacApp` do not read it: pass each of them its icon explicitly.
   */
  icon?: AppIdentityIcon;
};

export type AppIdentity = {
  readonly appId: string;
  readonly appName: string;
  readonly slug: string;
  readonly version: string;
  readonly urlSchemes: readonly string[];
  readonly icon?: AppIdentityIcon;
  /** Per-user application data directory (`appDataDir(slug)`). Not created automatically. */
  readonly dataDir: string;
};

export function validateUrlScheme(scheme: string): string {
  const normalized = scheme.trim().toLowerCase();
  if (!SCHEME_RE.test(normalized)) {
    throw new Error(`sweetview: invalid URL scheme ${JSON.stringify(scheme)} (must match /^[a-z][a-z0-9+.-]*$/i)`);
  }
  return normalized;
}

function defaultSlug(appId: string, appName: string): string {
  const last = appId.split(".").filter(Boolean).at(-1) ?? appName;
  const cleaned = last.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "sweetview-app";
}

export function defineAppIdentity(input: AppIdentityInput): AppIdentity {
  const appId = input.appId.trim();
  const appName = input.appName.trim();
  if (!appId) throw new Error("sweetview: defineAppIdentity requires a non-empty appId");
  if (!appName) throw new Error("sweetview: defineAppIdentity requires a non-empty appName");
  const slug = input.slug?.trim() || defaultSlug(appId, appName);
  const version = input.version?.trim() || "0.1.0";
  const urlSchemes = Object.freeze((input.urlSchemes ?? []).map(validateUrlScheme));
  return Object.freeze({
    appId,
    appName,
    slug,
    version,
    urlSchemes,
    icon: input.icon,
    dataDir: appDataDir(slug),
  });
}
