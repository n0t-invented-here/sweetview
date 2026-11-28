# Activation and single instance

Deep links (`myapp://open/note/42`) and "open a second copy" both mean the
same thing to a desktop app: the user wants the running app to do something.
This page covers registering a URL scheme, keeping one instance per user,
handing a second launch's arguments to the first, and delivering URLs only
when the app is ready for them. Part of the [native module](../native.md).

All of these are exported from `@n1h/sweetview/native`, and the root
`@n1h/sweetview` re-exports them for apps that already import it.

- [The whole flow](#the-whole-flow)
- [registerUrlScheme and unregisterUrlScheme](#registerurlscheme-and-unregisterurlscheme)
- [singleInstance](#singleinstance)
- [onOpenUrl and startup buffering](#onopenurl-and-startup-buffering)
- [signalReady](#signalready)
- [extractUrlFromArgs](#extracturlfromargs)

## The whole flow

A tray app that handles `notes://open/note/42`, run once per user. It has no
page, so it calls `signalReady()` itself once its handler is installed; a
webview page's handshake does that for an app with a page.

```ts
import {
  Tray,
  defineAppIdentity,
  onOpenUrl,
  quitEventLoop,
  registerUrlScheme,
  runEventLoop,
  signalReady,
  singleInstance,
} from "@n1h/sweetview/native";

const identity = defineAppIdentity({ appId: "com.example.notes", appName: "Notes", urlSchemes: ["notes"] });

const lock = await singleInstance({
  identity,
  onSecondInstance: ({ args, cwd }) => console.log("second launch", args, cwd),
});
if (!lock.isPrimary) {
  if (lock.handedOff) process.exit(0); // the primary's transport accepted our args and URL
  // Delivery failed (primary still starting, or hung): tell the user and exit,
  // or retry; starting a second primary is the app's choice.
  console.error("Notes is already running but did not respond.");
  process.exit(1);
}

const tray = new Tray({ tooltip: "Notes", menu: [{ label: "Quit", click: () => quitEventLoop() }] });

// notes://open/note/42 -> "42"
const openNote = (url: string) => {
  const id = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "(none)";
  tray.setTooltip(`Notes: note ${id}`);
  console.log(`open note ${id}`);
};

// Windows: per-user registry; macOS: validation only. Compiled, the default
// command launches the app. Under `bun run`, process.execPath is bun.exe, so
// pass the whole command line to launch your script instead.
const compiled = !process.execPath.toLowerCase().endsWith("bun.exe");
registerUrlScheme(
  "notes",
  compiled ? { identity } : { identity, command: `"${process.execPath}" "${Bun.main}" "%1"` },
);
onOpenUrl(openNote); // buffered until signalReady()
signalReady();       // this app has no page, so it signals ready itself

await runEventLoop(); // when the script ends, the tray goes and the lock is released: a later launch becomes the primary
```

A shared [`AppIdentity`](../settings-store.md#defineappidentity) supplies
the app ID, name and schemes to every call, and to
[`makeMacApp`](../build.md#makemacapp) for the macOS bundle.

## registerUrlScheme and unregisterUrlScheme

`registerUrlScheme(scheme, options?)` and `unregisterUrlScheme(scheme)`
return nothing. The scheme is trimmed, lowercased and validated against
`/^[a-z][a-z0-9+.-]*$/i`; an invalid one throws
`sweetview: invalid URL scheme "<scheme>" (must match /^[a-z][a-z0-9+.-]*$/i)`
on both platforms.

The platforms register schemes in fundamentally different places, which is
why these calls do real work on Windows and almost none on macOS:

- Windows keeps URL protocol handlers in the registry, and a user can write
  their own part of it at any time. `registerUrlScheme` writes
  `HKCU\Software\Classes\<scheme>` (no administrator rights, no UAC prompt):
  the default value `URL:<appName> Protocol`, an empty `URL Protocol`
  value, `DefaultIcon`, and `shell\open\command`. `unregisterUrlScheme`
  deletes that key tree. Call `registerUrlScheme` on every start; it is
  cheap and keeps the path current when the executable moves.
- macOS Launch Services has no per-user runtime registry an app can write to.
  It reads `CFBundleURLTypes` from the signed `.app` bundle's `Info.plist`
  when the bundle is registered, on first launch or when it is copied into
  place. So both functions only validate the scheme; declare schemes at
  build time with `makeMacApp({ identity })` or `makeMacApp({ urlSchemes })`
  ([build](../build.md#makemacapp)), and remove one by rebuilding the bundle
  without it.

`RegisterUrlSchemeOptions` (all Windows-only):

| Field | Default | Meaning |
|---|---|---|
| `identity` | none | Supplies `appName`. |
| `appName` | `identity.appName`, else the scheme | Protocol description. |
| `executablePath` | `process.execPath` | The program launched for the URL. |
| `iconPath` | `"<executablePath>,0"` | `DefaultIcon` value. |
| `command` | `"<executablePath>" "%1"` | Full command line; `%1` is the URL. |

`executablePath` defaults to `process.execPath`, the running program. In a
compiled executable that is the app. Under `bun run` it is `bun.exe`, so a
URL would launch Bun with the URL as its only argument rather than your
script. When testing from source on Windows, pass the whole command line:

```ts
import { registerUrlScheme } from "@n1h/sweetview/native";

registerUrlScheme("notes", {
  command: `"${process.execPath}" "${Bun.main}" "%1"`, // bun.exe <your entry script> <url>
});
```

Registry failures throw `sweetview: RegCreateKeyExW(...) failed (<code>)`,
`RegSetValueExW(...)` or `RegDeleteTreeW(...)` with the Win32 status.

## singleInstance

```ts
singleInstance(options: SingleInstanceOptions): Promise<SingleInstanceLock>
```

Makes the first process for an app ID the primary instance. Every later
launch is a secondary: it sends `{ args, cwd, url? }` to the primary and
should exit.

| Option | Meaning |
|---|---|
| `appId` | Unique app ID. Required unless `identity` is given. |
| `identity` | Supplies `appId` and `urlSchemes`. |
| `urlSchemes` | Schemes to look for in the launch arguments. Default `identity.urlSchemes`. |
| `args` | The arguments to hand off. Default `process.argv.slice(1)`. |
| `onSecondInstance(event)` | Called on the primary, on the UI thread, for each secondary launch. |

Without an app ID it throws
`sweetview: singleInstance requires appId or identity`.

The lock:

| Field | Meaning |
|---|---|
| `isPrimary` | Whether this process holds the lock. |
| `handedOff` | Secondary only: the payload was delivered over the native transport. Always `false` on the primary. |
| `dispose()` | Primary: releases the lock and listener, so a later launch becomes primary. A no-op on a secondary. The lock is released when the application ends anyway ([the end of the application](../app.md#the-end-of-the-application)). |

`handedOff` reports transport delivery (Windows `WM_COPYDATA` returned
success; macOS `CFMessagePortSendRequest` succeeded), not that the primary's
handler ran or succeeded. A secondary whose `handedOff` is `false` (the
primary was still starting, or is hung) can show its own message or start
anyway; that is the app's choice.

On macOS, calling `singleInstance` a second time for the same app ID inside
the process that already holds the lock does not create a second port: it
invokes the existing `onSecondInstance` handler in-process with the new
payload and returns `{ isPrimary: false, handedOff: true }`.

How each platform finds the primary:

- Windows: a named mutex, `Local\sweetview.instance.<id>` (the app ID made
  safe for kernel object names), per user session. The primary also creates a hidden message-only window; a
  secondary finds it (retrying for up to about a quarter second while the
  primary starts) and sends the JSON payload with `WM_COPYDATA`.
- macOS: a Core Foundation `CFMessagePort` named from a SHA-256 of the app
  ID, served on the main run loop. A secondary that fails to create the
  port sends the payload to the existing one, with a 1.5 s timeout.

On the primary, a URL found in its own launch arguments is queued into
[`onOpenUrl`](#onopenurl-and-startup-buffering). A secondary's URL is queued
too, before `onSecondInstance` runs, so URL handling lives in one place.

## onOpenUrl and startup buffering

```ts
onOpenUrl(handler: (url: string) => void): () => void
```

Subscribes to activation URLs and returns an unsubscribe function. URLs come
from three places:

| Source | Windows | macOS |
|---|---|---|
| Cold launch by URL | the URL is a launch argument; `singleInstance` picks it up | a `kAEGetURL` Apple Event |
| Warm launch (app already running) | a secondary instance hands it off through `singleInstance` | a `kAEGetURL` Apple Event to the running app |
| Second launch with a URL argument | `singleInstance` | `singleInstance` |

On Windows, an app that does not use `singleInstance` reads its own launch
URL with [`extractUrlFromArgs`](#extracturlfromargs).

URLs that arrive before the app is ready are buffered, because a cold-launch
URL usually arrives before the window and page exist to show it. They are
delivered in arrival order when [`signalReady()`](#signalready) runs; after
that, each URL is delivered as it comes. A handler that throws is logged and
the others still run.

## signalReady

```ts
signalReady(): void
```

Marks the app ready for activation URLs and drains the buffer in order. Only
the first call does anything.

With a webview you rarely call it: when the page calls `signalReady()` from
[`@n1h/sweetview/page`](../page.md#signalready), the host calls this one on
the first handshake of any webview in the process. An app without a page
(tray-only, or a native overlay) calls it once its handlers are installed.

## extractUrlFromArgs

```ts
extractUrlFromArgs(args: readonly string[], schemes?: readonly string[]): string | undefined
```

Returns the first argument that looks like `scheme://...` with a scheme from
`schemes` (validated and compared lowercase), or, without `schemes`, the
first such argument whose scheme is not `http`, `https` or `file`. An empty
`schemes` array (`[]`) behaves like omitting it and uses the same fallback. An invalid
scheme in `schemes` throws as in
[`registerUrlScheme`](#registerurlscheme-and-unregisterurlscheme).
