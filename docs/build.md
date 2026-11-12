# @n1h/sweetview/build

Build-time helpers for shipping an app: the icon files a build uses, and the macOS `.app` bundle around the compiled binary. They run on any OS in any build script and load neither `bun:ffi` nor the webview library. This page also covers the `make-app.ts` command line and the `@n1h/sweetview/file-imports` types.

```ts
import { makeMacApp, writeIconFiles, type MacAppOptions } from "@n1h/sweetview/build";
```

## Reference

### MacAppOptions

```ts
export type MacAppOptions = {
  name: string;
  bundleId: string;
  binary: string;
  outDir: string;
  icns?: string;
  version?: string;
  minimumSystemVersion?: string;
  plist?: Record<string, string | number | boolean>;
  sign?: string | false;
};
```

The options of `makeMacApp`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | What Finder, the Dock and the menu bar show. The bundle is `<name>.app`. Written as `CFBundleName` and `CFBundleDisplayName`. |
| `bundleId` | `string` | required | The reverse-DNS bundle id, such as `com.example.my-app`. Written as `CFBundleIdentifier`. macOS notifications need one, so a bare binary cannot send them. |
| `binary` | `string` | required | The compiled macOS executable, from `bun build --compile --target=bun-darwin-arm64`. Copied in under its own file name. |
| `outDir` | `string` | required | The folder the bundle is written into. Created when missing. An existing `<name>.app` there is deleted first. |
| `icns` | `string` | none | The `.icns` file for Finder and the Dock, for example one written by `writeIconFiles`. Without it the bundle has no icon file and shows the stock icon. |
| `version` | `string` | `"0.1.0"` | Written as `CFBundleVersion` and `CFBundleShortVersionString`. |
| `minimumSystemVersion` | `string` | `"11.0"` | Written as `LSMinimumSystemVersion`. |
| `plist` | `Record<string, string \| number \| boolean>` | none | More `Info.plist` entries by key, such as `{ LSUIElement: true }` for a menu-bar app with no Dock tile. An entry with a new key is written after the defaults. An entry with the key of a default replaces that default's value in the default's position. |
| `sign` | `string \| false` | `"-"` on macOS, `false` elsewhere | The `codesign` identity for the bundle: `"-"` for an ad-hoc signature, a certificate name such as `"Developer ID Application: Example (TEAMID)"`, or `false` to leave the bundle unsigned. A bundle that is not signed is refused by macOS's notification service and shows no notifications: Bun's compiled binary carries only a linker signature with the identifier `a.out`, and the bundle around it has no seal. |

### makeMacApp

```ts
export function makeMacApp(options: MacAppOptions): string
```

Wraps the compiled macOS binary in a `.app` bundle at `<outDir>/<name>.app`, and on macOS signs it. Finder then launches it without a Terminal window, and notifications have the signed bundle they need.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `options` | `MacAppOptions` | required | See `MacAppOptions`. |

It checks that `binary` exists, and `icns` when set. It then deletes any existing bundle at that path and writes these files:

| Path inside `<name>.app` | Content |
|---|---|
| `Contents/MacOS/<binary file name>` | A copy of `binary`, with mode `0755`. |
| `Contents/Resources/AppIcon.icns` | A copy of `icns`. Written only when `icns` is set; the `Resources` folder is created either way. |
| `Contents/Info.plist` | An XML property list with the keys below. |
| `Contents/PkgInfo` | The text `APPL????`. |

`Info.plist` holds these keys, in this order, followed by the `plist` entries with new keys:

| Key | Value |
|---|---|
| `CFBundleName` | `name` |
| `CFBundleDisplayName` | `name` |
| `CFBundleIdentifier` | `bundleId` |
| `CFBundleVersion` | `version`, default `0.1.0` |
| `CFBundleShortVersionString` | `version`, default `0.1.0` |
| `CFBundleExecutable` | the file name of `binary` |
| `CFBundleIconFile` | `AppIcon`; present only when `icns` is set |
| `CFBundlePackageType` | `APPL` |
| `CFBundleInfoDictionaryVersion` | `6.0` |
| `LSMinimumSystemVersion` | `minimumSystemVersion`, default `11.0` |
| `NSHighResolutionCapable` | `true` |
| `NSPrincipalClass` | `NSApplication` |

A boolean value is written as `<true/>` or `<false/>`, an integer as `<integer>`, any other number as `<real>`, and a string as `<string>`. `NaN` and infinities throw, because a plist cannot hold them. `&`, `<` and `>` in keys and strings are escaped.

With `sign` set, or left at its macOS default, the files are then signed with `codesign --sign <identity> --force --deep "<name>.app"`, which gives the bundle a signature whose identifier is the bundle id. The ad-hoc signature is what macOS's notification service wants before it shows the permission prompt; it also refuses an app that runs from a temporary folder such as `/tmp`, signed or not, so keep the bundle where it is built or in an Applications folder.

On a Mac that calls a copied bundle damaged, `xattr -dr com.apple.quarantine "<name>.app"`, `chmod +x "<name>.app/Contents/MacOS/"*` and `codesign --sign - --force --deep "<name>.app"` remove the quarantine flag, restore the executable bit and sign it again.

Returns: the bundle's path, `<outDir>/<name>.app`.

Throws: `makeMacApp: <binary> not found (compile the macOS binary first)` when `binary` does not exist. Nothing is deleted or written in that case.

Throws: `makeMacApp: <icns> not found (write the .icns first)` when `icns` is set and does not exist. Nothing is deleted or written in that case.

Throws: any file-system error from deleting, copying or writing, unchanged.

Throws: `makeMacApp: codesign failed for <app>: <codesign's message>` when `codesign` exits non-zero, for example when `binary` is not a Mach-O file; `makeMacApp: codesign could not run (<reason>); pass sign: false to leave the bundle unsigned` when `sign` is set on a machine without `codesign`. The bundle's files are already written in both cases.

Platforms: Windows / macOS / Linux: implemented; only macOS signs by default, and only macOS has `codesign`. On Windows `chmodSync` cannot set an executable bit, so a bundle built there needs the `chmod +x` above on the Mac, and a bundle built on any other OS needs the `codesign` line above before it can show notifications.

Thread: blocks the calling thread on file I/O.

### writeIconFiles

```ts
export function writeIconFiles(dir: string, files: { ico?: Uint8Array; icns?: Uint8Array }): string[]
```

Writes the icon files a build embeds into `dir`, creating the folder and any missing parents. Existing files of the same name are replaced. The encoders for both formats, such as `icoFromRgba` and `icnsFromRgba`, are in `@n1h/sweetview/native`, see [native.md](native.md).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `dir` | `string` | required | The folder to write into. |
| `files.ico` | `Uint8Array` | none | Written as `<dir>/app.ico`, for `bun build --compile --windows-icon=<dir>/app.ico`. That flag works only on a Windows build host. |
| `files.icns` | `Uint8Array` | none | Written as `<dir>/AppIcon.icns`, for the `icns` option of `makeMacApp`. |

Returns: the paths written, `app.ico` first when present, then `AppIcon.icns`.

Throws: any file-system error from creating the folder or writing, unchanged.

Thread: blocks the calling thread on file I/O.

## make-app command line

`src/make-app.ts` is `makeMacApp` as a command. It is not a package export. Run it by path with Bun: `bun node_modules/@n1h/sweetview/src/make-app.ts --name "My App" --bundle-id com.example.my-app --binary dist/my-app-macos-arm64 --out dist`. It calls `makeMacApp` and writes the same files. Importing the file runs nothing.

| Flag | Value | Default | Meaning |
|---|---|---|---|
| `--name` | text | required | `name`: what Finder and the Dock show. The bundle is `<name>.app`. |
| `--bundle-id` | text | required | `bundleId`: the reverse-DNS id. |
| `--binary` | path | required | `binary`: the compiled macOS executable. |
| `--out` | path | required | `outDir`: the folder the bundle is written into. An existing `<name>.app` there is replaced. |
| `--icns` | path | none | `icns`: the `.icns` for Finder and the Dock. The stock icon without it. |
| `--version` | text | `0.1.0` | `version`: `CFBundleVersion` and `CFBundleShortVersionString`. |
| `--min-macos` | text | `11.0` | `minimumSystemVersion`: `LSMinimumSystemVersion`. |
| `--plist` | `Key=value` | none | One extra `Info.plist` entry. Repeatable; a later entry with the same key wins. |
| `--sign` | text | ad-hoc on macOS, none elsewhere | `sign`: the `codesign` identity. |
| `--no-sign` | none | off | `sign: false`: leave the bundle unsigned. Excludes `--sign`. |
| `--help`, `-h` | none | off | Prints the usage text to stdout and exits. |

A `--plist` entry splits at its first `=`. The value may contain further `=` signs. The value `true` or `false` becomes a boolean. A `--name` of empty text counts as missing. A non-blank value that `Number()` reads as a finite number, such as `42`, `1.5` or `0x10`, becomes a number and is written as `<integer>` or `<real>`. Anything else stays a string.

| Exit code | When | Output |
|---|---|---|
| `0` | The bundle was written. | `wrote <path>` on stdout. |
| `0` | `--help` or `-h`. | The usage text on stdout. |
| `1` | `makeMacApp` threw, for example a missing binary or icns file. | The error message on stderr. |
| `2` | An unknown flag, a positional argument, or a flag without its value. | The parser's message and the usage text on stderr. |
| `2` | One or more required flags missing. | `missing: --name, --bundle-id, ...` listing the missing ones, then the usage text, on stderr. |
| `2` | A `--plist` entry with no `=` or an empty key. | `--plist wants Key=value, got "<entry>"` on stderr. |
| `2` | Both `--sign` and `--no-sign`. | `--sign and --no-sign exclude each other` on stderr. |

## File-import types

`@n1h/sweetview/file-imports` is a types-only module: the package maps it to `file-imports.d.ts` under the `types` condition, and it has no runtime module. It declares path-valued modules for the files an app imports with `with { type: "file" }`, such as `import js from "./build/frontend/main.js" with { type: "file" };`. Bun resolves such an import to a path the file can be read from. `Bun.file(js)` reads that file and can be passed as an asset to `createWebviewApp`, see [app.md](app.md). `bun build --compile` embeds the file.

| Module pattern | Default export |
|---|---|
| `*.css` | `string`, the file's path |
| `*.js` | `string`, the file's path |

An app references the module from a `.d.ts` file of its own with `/// <reference types="@n1h/sweetview/file-imports" />`. Other file kinds, such as `*.png` or `*.glb`, need their own `declare module` beside that line.

## Example

```ts
import { makeMacApp, writeIconFiles } from "@n1h/sweetview/build";

declare const ico: Uint8Array;
declare const icns: Uint8Array;

writeIconFiles("build", { ico, icns });
const app = makeMacApp({
  name: "My App",
  bundleId: "com.example.my-app",
  binary: "dist/my-app-macos-arm64",
  outDir: "dist",
  icns: "build/AppIcon.icns",
  plist: { LSUIElement: true },
});
console.log(app);
```
