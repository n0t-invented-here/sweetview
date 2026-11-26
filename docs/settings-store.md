# @n1h/sweetview/settings-store

A settings file for a small app: one JSON document in the user's per-app folder, read once at start and written whole on every change. Every call is synchronous, so the UI thread can use it after `run()` has blocked it in the OS loop, and it runs on any thread and in any build or test script. It imports only `node:fs`, `node:os` and `node:path`, and loads neither `bun:ffi` nor the webview library.

The settings store is `@n1h/sweetview/settings-store` in the facade, or
`@n1h/sweetview-settings/settings-store` standalone. The app identity, which
names the settings folder and is shared with the native and build helpers,
lives beside it in `@n1h/sweetview-settings`.

- [App identity](#app-identity)
  - [defineAppIdentity](#defineappidentity)
  - [AppIdentityInput, AppIdentity and AppIdentityIcon](#appidentityinput-appidentity-and-appidentityicon)
  - [validateUrlScheme](#validateurlscheme)
- [Reference](#reference)
  - [appDataDir](#appdatadir)
  - [SettingsStoreOptions](#settingsstoreoptions)
  - [SettingsStore](#settingsstore)
  - [createSettingsStore](#createsettingsstore)
- [Example](#example)

## App identity

One `AppIdentity` names the app everywhere it needs a name: the settings
folder (`SettingsStore`), the single-instance lock and URL schemes
(`singleInstance`, `registerUrlScheme`), the Windows toast identity
(`Notifier`), the default window title and Windows window icon (`Window`),
and the macOS bundle (`makeMacApp`). It is plain data with no `bun:ffi` or
webview import, so build scripts use it on any OS.

```ts
import { defineAppIdentity } from "@n1h/sweetview-settings";
import { SettingsStore } from "@n1h/sweetview/settings-store";

const identity = defineAppIdentity({
  appId: "com.example.notes",
  appName: "Notes",
  urlSchemes: ["example-notes"],
});
const settings = new SettingsStore({ identity, defaults: { theme: "system" } });
```

Where to import it from:

| Path | Exports |
|---|---|
| `@n1h/sweetview`, `@n1h/sweetview/native`, `@n1h/sweetview/build` | `defineAppIdentity`, `AppIdentity`, `AppIdentityInput` |
| `@n1h/sweetview-settings` | everything on this page, including `AppIdentityIcon` and `validateUrlScheme` |
| `@n1h/sweetview-settings/app-identity` | the identity alone: `defineAppIdentity`, `validateUrlScheme`, `AppIdentity`, `AppIdentityInput`, `AppIdentityIcon` |

The facade's `@n1h/sweetview/settings-store` exports the store only, not the
identity.

### defineAppIdentity

```ts
defineAppIdentity(input: AppIdentityInput): AppIdentity
```

Normalizes the input into a frozen `AppIdentity`:

| Field | Rule |
|---|---|
| `appId`, `appName` | Trimmed. Empty after trimming throws `sweetview: defineAppIdentity requires a non-empty appId` (or `appName`). |
| `slug` | Trimmed; when omitted or blank, derived from the last dot-separated segment of `appId` (or `appName` when `appId` has none), lowercased, with runs of characters other than `a-z 0-9 . _ -` replaced by `-` and leading and trailing `-` removed; `sweetview-app` if nothing is left. `com.example.My Notes!` gives `my-notes`. An explicit slug is used as given, so keep it a valid folder name. |
| `version` | Trimmed; `"0.1.0"` when omitted or blank. |
| `urlSchemes` | Each passed through [`validateUrlScheme`](#validateurlscheme): trimmed, lowercased, validated. The array is frozen. |
| `icon` | Passed through unchanged. |
| `dataDir` | `appDataDir(slug)`. The folder is not created. |

What it deliberately does not check: that `appId` is reverse-DNS
(`com.example.app`), that `version` is semver, or that `icon`'s `rgba`
length matches `width * height * 4`. A `Window` that uses the icon checks the
dimensions when it is created and throws
`sweetview: identity icon dimensions do not match its RGBA data`. Creating an
identity never touches the file system.

### AppIdentityInput, AppIdentity and AppIdentityIcon

```ts
type AppIdentityInput = {
  appId: string;                       // reverse-DNS by convention: macOS bundle ID, lock name, toast AUMID
  appName: string;                     // title bars, Finder, menus, protocol descriptions
  slug?: string;                       // folder name under the app-data directory
  version?: string;                    // default "0.1.0"
  urlSchemes?: readonly string[];      // e.g. ["my-app"]
  icon?: AppIdentityIcon;
};

type AppIdentity = {
  readonly appId: string;
  readonly appName: string;
  readonly slug: string;
  readonly version: string;
  readonly urlSchemes: readonly string[];
  readonly icon?: AppIdentityIcon;
  readonly dataDir: string;
};

type AppIdentityIcon = { readonly rgba: Uint8Array; readonly width: number; readonly height: number };
```

`AppIdentityIcon` is top-down RGBA pixels. Its only automatic consumer is
`new Window({ identity })` on Windows, which encodes it as the window icon
when no `icon` option is given, centering a non-square image on a
transparent square. macOS windows have no per-window icon. Trays,
`writeIconFiles`, `setAppIcon` and `makeMacApp` do not read it; give each its
icon explicitly, for example with `icnsFromRgba` for the bundle
([build](build.md#macappoptions)).

### validateUrlScheme

```ts
import { validateUrlScheme } from "@n1h/sweetview-settings";

validateUrlScheme(" Example-Notes "); // "example-notes"
```

```ts
validateUrlScheme(scheme: string): string
```

Trims and lowercases `scheme` and checks it against
`/^[a-z][a-z0-9+.-]*$/i`: a letter, then letters, digits, `+`, `.` or `-`.
Returns the normalized scheme, or throws
`sweetview: invalid URL scheme "<scheme>" (must match /^[a-z][a-z0-9+.-]*$/i)`.
`defineAppIdentity`, `registerUrlScheme`, `singleInstance` and `makeMacApp`
all use it, so a scheme is spelled the same everywhere.

## Reference

The store, from `@n1h/sweetview/settings-store`:

```ts
import { appDataDir, createSettingsStore, SettingsStore, type SettingsStoreOptions } from "@n1h/sweetview/settings-store";
```

### appDataDir

```ts
export function appDataDir(app: string): string
```

Returns the per-user folder an app keeps its own files in. It does not create the folder.

| Field | Type | Meaning |
|---|---|---|
| `app` | `string` | The app's folder name, joined onto the per-user base folder. |

The base folder depends on `process.platform`:

| Platform | Folder | When the variable is unset |
|---|---|---|
| Windows (`win32`) | `%APPDATA%\<app>` | `<home>\AppData\Roaming\<app>` |
| macOS (`darwin`) | `~/Library/Application Support/<app>` | not applicable |
| Linux and every other platform | `$XDG_CONFIG_HOME/<app>` | `~/.config/<app>` |

Returns: the folder path. `<home>` and `~` are `os.homedir()`.

Platforms: Windows / macOS / Linux: implemented, with the base folder from the table.

### SettingsStoreOptions

```ts
export type SettingsStoreOptions<T> = {
  app?: string;
  identity?: AppIdentity;
  file?: string;
  dir?: string;
  defaults: T;
  sanitize?: (input: unknown) => T;
};
```

The options of `createSettingsStore`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `app` | `string` | `identity.slug` | Explicit folder name under `appDataDir`. The constructor requires either `app` or `identity`, including when `dir` is set. |
| `identity` | `AppIdentity` | none | Shared app identity supplying the default folder name. |
| `file` | `string` | `"settings.json"` | The file name inside the folder. |
| `dir` | `string` | `appDataDir(app)` | The folder itself, in place of the app-data folder. For tests, or an app that keeps settings elsewhere. |
| `defaults` | `T` | required | The base of the default `sanitize`. `load()` returns a shallow copy of it when `sanitize` throws. |
| `sanitize` | `(input: unknown) => T` | shallow merge over `defaults` | Turns whatever the file held into a valid `T`: fill gaps, clamp ranges, drop junk. Receives the parsed JSON, or `undefined` when the file is missing, cannot be read or is not valid JSON. |

The default `sanitize` returns `{ ...defaults, ...input }` when `input` is a non-null object, and a shallow copy of `defaults` otherwise. The merge is one level deep: a nested object in the file replaces the default's nested object whole. Values are not type-checked. Keys that `defaults` lacks are kept. A JSON array is not an object here: it gives a copy of `defaults`.

### SettingsStore

```ts
export class SettingsStore<T extends object> {
  readonly path: string;
  constructor(options: SettingsStoreOptions<T>);
  load(): T;
  save(settings: T): void;
}
```

Construct directly with `new SettingsStore(options)` or via the `createSettingsStore(options)` alias. It touches no file at construction.

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | The full path of the settings file. The file need not exist yet. |
| `load` | `() => T` | Reads the file and returns the settings. |
| `save` | `(settings: T) => void` | Writes the whole document. |

`load()` handles each file state as follows. Logging goes to stderr through `console.error`, with `<message>` the error's message.

| File state | Logged | Returns |
|---|---|---|
| Missing | nothing | `sanitize(undefined)`; with the default `sanitize`, a copy of `defaults` |
| Valid JSON | nothing | `sanitize(parsed)` |
| Not valid JSON | `settings: <path> unreadable, using defaults: <message>` | `sanitize(undefined)`, as for a missing file |
| Cannot be read, for example no permission or a folder at the path | same as above | same as above |
| `sanitize` throws, on any path | `settings: sanitize failed for <path>, using defaults: <message>`, after the line for the file state when there is one | a shallow copy of `defaults` |

`save(settings)` creates the folder and any missing parents, then writes `JSON.stringify(settings, null, 2)` followed by a newline, as UTF-8. It writes to `<path>.<pid>.tmp` beside the file and renames that over the file, so an interrupted write leaves the previous document rather than a truncated one. It does not call `sanitize`. When creating the folder, serialising, writing or renaming fails, it deletes the temporary file, logs `settings: could not write <path>: <message>` to stderr and returns normally.

Neither `load()` nor `save()` throws. Failures are logged to stderr.

Thread: any thread. Both calls block the calling thread on file I/O.

### createSettingsStore

```ts
export function createSettingsStore<T extends object>(options: SettingsStoreOptions<T>): SettingsStore<T>
```

Creates a store for one settings file. It touches no file at creation. The file path is `dir`, or `appDataDir(app)` when `dir` is unset, joined with `file`, or `settings.json` when `file` is unset.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `options` | `SettingsStoreOptions<T>` | required | See `SettingsStoreOptions`. |

Returns: a `SettingsStore<T>` for that path.

## Example

```ts
import { SettingsStore } from "@n1h/sweetview/settings-store";

type Settings = { volume: number; muted: boolean };
const DEFAULTS: Settings = { volume: 50, muted: false };

const store = new SettingsStore<Settings>({
  app: "my-app",
  defaults: DEFAULTS,
  sanitize: (input) => {
    const s = (typeof input === "object" && input !== null ? input : {}) as Partial<Settings>;
    return { volume: typeof s.volume === "number" ? Math.min(100, Math.max(0, s.volume)) : DEFAULTS.volume, muted: s.muted === true };
  },
});
let settings = store.load();
store.save((settings = { ...settings, muted: true }));
```
