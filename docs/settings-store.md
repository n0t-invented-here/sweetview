# @n1h/sweetview/settings-store

A settings file for a small app: one JSON document in the user's per-app folder, read once at start and written whole on every change. Every call is synchronous, so the UI thread can use it after `run()` has blocked it in the OS loop, and it runs on any thread and in any build or test script. It imports only `node:fs`, `node:os` and `node:path`, and loads neither `bun:ffi` nor the webview library.

```ts
import { appDataDir, createSettingsStore, type SettingsStore, type SettingsStoreOptions } from "@n1h/sweetview/settings-store";
```

- [Reference](#reference)
  - [appDataDir](#appdatadir)
  - [SettingsStoreOptions](#settingsstoreoptions)
  - [SettingsStore](#settingsstore)
  - [createSettingsStore](#createsettingsstore)
- [Example](#example)

## Reference

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
  app: string;
  file?: string;
  dir?: string;
  defaults: T;
  sanitize?: (input: unknown) => T;
};
```

The options of `createSettingsStore`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `app` | `string` | required | The folder name under `appDataDir`. Not used when `dir` is set. |
| `file` | `string` | `"settings.json"` | The file name inside the folder. |
| `dir` | `string` | `appDataDir(app)` | The folder itself, in place of the app-data folder. For tests, or an app that keeps settings elsewhere. |
| `defaults` | `T` | required | The base of the default `sanitize`. `load()` returns a shallow copy of it when `sanitize` throws. |
| `sanitize` | `(input: unknown) => T` | shallow merge over `defaults` | Turns whatever the file held into a valid `T`: fill gaps, clamp ranges, drop junk. Receives the parsed JSON, or `undefined` when the file is missing, cannot be read or is not valid JSON. |

The default `sanitize` returns `{ ...defaults, ...input }` when `input` is a non-null object, and a shallow copy of `defaults` otherwise. The merge is one level deep: a nested object in the file replaces the default's nested object whole. Values are not type-checked. Keys that `defaults` lacks are kept. A JSON array is not an object here: it gives a copy of `defaults`.

### SettingsStore

```ts
export type SettingsStore<T> = {
  readonly path: string;
  load(): T;
  save(settings: T): void;
};
```

The handle `createSettingsStore` returns.

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
import { createSettingsStore } from "@n1h/sweetview/settings-store";

type Settings = { volume: number; muted: boolean };
const DEFAULTS: Settings = { volume: 50, muted: false };

const store = createSettingsStore<Settings>({
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
