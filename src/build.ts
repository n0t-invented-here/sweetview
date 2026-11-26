// Build-time helpers for shipping a sweetview app: the icon files the
// executables embed, and the macOS .app bundle around the compiled binary.
// Plain file writing; runs on any OS, imports nothing native, so a build
// script can use it on a machine without the webview library.
//
//   import { makeMacApp, writeIconFiles } from "@n1h/sweetview/build";
//
// The bundle is also a script to run: src/make-app.ts.

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defineAppIdentity, validateUrlScheme, type AppIdentity, type AppIdentityInput } from "./app-identity";

export { defineAppIdentity, type AppIdentity, type AppIdentityInput };

export type MacAppOptions = {
  /** Optional unified app identity supplying defaults for `name`, `bundleId`, `version`, and `urlSchemes`. */
  identity?: AppIdentity;
  /** What Finder, the Dock and the menu bar show; the bundle is `<name>.app`. Required unless `identity` is given. */
  name?: string;
  /** Reverse-DNS, `dev.example.my-app`. Required unless `identity` is given. */
  bundleId?: string;
  /** The compiled macOS executable (`bun build --compile --target=bun-darwin-arm64 …`). Copied in under its own file name. */
  binary: string;
  /** Where `<name>.app` goes; one already there is replaced. */
  outDir: string;
  /** The `.icns` for Finder and the Dock (written by `writeIconFiles`). Without it the bundle shows the stock icon. */
  icns?: string;
  /** `CFBundleVersion` and `CFBundleShortVersionString`. Default `0.1.0` (or `identity.version`). */
  version?: string;
  /** `LSMinimumSystemVersion`. Default `11.0`. */
  minimumSystemVersion?: string;
  /** Custom URL schemes written as `CFBundleURLTypes` in `Info.plist`, e.g. `["my-app"]`. */
  urlSchemes?: readonly string[];
  /** More `Info.plist` entries, by key: `{ LSUIElement: true }` for a menu-bar-only app with no Dock tile, say. These win over the defaults. */
  plist?: Record<string, string | number | boolean>;
  /**
   * The `codesign` identity for the bundle: `"-"` for an ad-hoc signature, or a
   * certificate name such as `"Developer ID Application: Example (TEAMID)"`;
   * `false` leaves the bundle unsigned. Default: ad-hoc on macOS, `false`
   * elsewhere, where `codesign` does not exist.
   */
  sign?: string | false;
};

const plistValue = (value: string | number | boolean): string =>
  typeof value === "boolean" ? (value ? "<true/>" : "<false/>") : typeof value === "number" ? (Number.isFinite(value) ? (Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`) : (() => { throw new Error(`Info.plist cannot hold ${value}`); })()) : `<string>${escapeXml(value)}</string>`;

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Wraps the compiled macOS binary in a `.app` bundle: `Contents/MacOS/<binary>`
 * (made executable), `Contents/Resources/AppIcon.icns`, `Info.plist`,
 * `PkgInfo`. Finder then launches it without a Terminal window and
 * notifications have the bundle id they need. On macOS the bundle is then
 * signed, ad-hoc unless `sign` names an identity, because an unsigned bundle
 * is refused by the notification service. Returns the bundle's path.
 *
 * If Finder calls the bundle damaged on the Mac it was copied to: `xattr -dr
 * com.apple.quarantine "<name>.app"`, `chmod +x "<name>.app/Contents/MacOS/"*`,
 * `codesign --sign - --force --deep "<name>.app"`.
 */
export function makeMacApp(options: MacAppOptions): string {
  const name = options.name ?? options.identity?.appName;
  const bundleId = options.bundleId ?? options.identity?.appId;
  if (!name) throw new Error("makeMacApp: name (or identity.appName) is required");
  if (!bundleId) throw new Error("makeMacApp: bundleId (or identity.appId) is required");
  if (!existsSync(options.binary)) throw new Error(`makeMacApp: ${options.binary} not found (compile the macOS binary first)`);
  if (options.icns !== undefined && !existsSync(options.icns)) throw new Error(`makeMacApp: ${options.icns} not found (write the .icns first)`);

  const schemes = (options.urlSchemes ?? options.identity?.urlSchemes ?? []).map(validateUrlScheme);
  const executable = basename(options.binary);
  const app = join(options.outDir, `${name}.app`);
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });

  cpSync(options.binary, join(macos, executable));
  chmodSync(join(macos, executable), 0o755); // kept by tar/zip, lost by some SMB copies
  if (options.icns !== undefined) cpSync(options.icns, join(resources, "AppIcon.icns"));

  const version = options.version ?? options.identity?.version ?? "0.1.0";
  const entries: Record<string, string | number | boolean> = {
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleIdentifier: bundleId,
    CFBundleVersion: version,
    CFBundleShortVersionString: version,
    CFBundleExecutable: executable,
    ...(options.icns !== undefined ? { CFBundleIconFile: "AppIcon" } : {}),
    CFBundlePackageType: "APPL",
    CFBundleInfoDictionaryVersion: "6.0",
    LSMinimumSystemVersion: options.minimumSystemVersion ?? "11.0",
    NSHighResolutionCapable: true,
    NSPrincipalClass: "NSApplication",
    ...options.plist,
  };
  const dictLines = Object.entries(entries).map(([key, value]) => `  <key>${escapeXml(key)}</key>${plistValue(value)}`);
  if (schemes.length > 0) {
    const schemeXml = schemes.map((s) => `          <string>${escapeXml(s)}</string>`).join("\n");
    dictLines.push(
      [
        `  <key>CFBundleURLTypes</key>`,
        `  <array>`,
        `    <dict>`,
        `      <key>CFBundleURLName</key><string>${escapeXml(bundleId)}</string>`,
        `      <key>CFBundleURLSchemes</key>`,
        `      <array>`,
        schemeXml,
        `      </array>`,
        `    </dict>`,
        `  </array>`,
      ].join("\n"),
    );
  }
  const dict = dictLines.join("\n");
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${dict}
</dict>
</plist>
`,
  );
  writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");

  const sign = options.sign ?? (process.platform === "darwin" ? "-" : false);
  if (sign !== false) signMacApp(app, sign);
  return app;
}

function signMacApp(app: string, identity: string): void {
  const result = spawnSync("codesign", ["--sign", identity, "--force", "--deep", app], { encoding: "utf8" });
  if (result.error) throw new Error(`makeMacApp: codesign could not run (${result.error.message}); pass sign: false to leave the bundle unsigned`);
  if (result.status !== 0) throw new Error(`makeMacApp: codesign failed for ${app}: ${(result.stderr || result.stdout).trim()}`);
}

/**
 * Writes the icon files a build embeds into `dir` (created if need be):
 * `app.ico` for the Windows executable (`bun build --compile
 * --windows-icon=<dir>/app.ico`, Windows build host only) and `AppIcon.icns`
 * for the `.app` bundle (`makeMacApp({ icns })`). Pass the ones you have;
 * returns the paths written.
 */
export function writeIconFiles(dir: string, files: { ico?: Uint8Array; icns?: Uint8Array }): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  if (files.ico) {
    const path = join(dir, "app.ico");
    writeFileSync(path, files.ico);
    written.push(path);
  }
  if (files.icns) {
    const path = join(dir, "AppIcon.icns");
    writeFileSync(path, files.icns);
    written.push(path);
  }
  return written;
}

/**
 * Windows: tells the shell that icons changed, so Explorer, the taskbar and the Start menu draw a
 * rebuilt program's icon. Without it they go on drawing the icon they kept from the file that was at
 * that path before the build, however the new file's icon differs. It is the call an installer makes
 * (SHChangeNotify with SHCNE_ASSOCCHANGED) and changes nothing on the computer. Elsewhere: does nothing.
 */
export function refreshWindowsIcons(): void {
  if (process.platform !== "win32") return;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const shell32 = dlopen("shell32.dll", { SHChangeNotify: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.void } });
    const SHCNE_ASSOCCHANGED = 0x08000000;
    const SHCNF_FLUSH = 0x1000;
    shell32.symbols.SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH, null, null);
    shell32.close();
  } catch {
    // The icon is in the file either way.
  }
}
