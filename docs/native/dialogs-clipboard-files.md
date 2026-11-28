# Dialogs, clipboard and files

A folder picker, synchronous clipboard text, and bounded reads of local
files. Part of the [native module](../native.md).

- [pickFolder](#pickfolder)
- [Clipboard](#clipboard)
- [Reading files](#reading-files)
  - [Whole files](#whole-files)
  - [Chunked reads](#chunked-reads)
  - [Errors](#errors)

## pickFolder

A page button that opens the folder dialog, in four files: the contract, the
host, the page and its script. Run it with `bun run host.ts`.

```ts
// shared.ts
export type Methods = { "library.choose": [void, string | null] };
export type Events = Record<string, never>;
```

```ts
// host.ts
import { WebView } from "@n1h/sweetview";
import { Window, pickFolder } from "@n1h/sweetview/native";
import type { Methods } from "./shared";
import page from "./index.html";

const win = new Window({ title: "Library", bounds: { x: 200, y: 200, width: 480, height: 240 } });
const view = await WebView.attach<Methods>(win, {
  page,
  deferredUiMethods: {
    "library.choose": () => pickFolder(win, "Choose a library folder"),
  },
});
win.show();
view.run(); // blocks until the window closes, then tears the webview down
```

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Library</title>
  </head>
  <body>
    <button id="choose">Choose a folder</button>
    <p id="folder"></p>
    <script type="module" src="./page.ts"></script>
  </body>
</html>
```

```ts
// page.ts
import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import type { Events, Methods } from "./shared";

const bridge = createBridge<Methods, Events>(webviewTransport());

document.getElementById("choose")!.addEventListener("click", async () => {
  const folder = await bridge.rpc("library.choose"); // pending until the user picks or cancels
  document.getElementById("folder")!.textContent = folder ?? "(cancelled)";
});
```

`pickFolder(owner, title: string): string | null`, where `owner` is a
`Window` (anything with a `handle`), a raw `WindowHandle`, or `null`, opens
the OS folder dialog and blocks until the user chooses a folder
(returns its absolute path) or cancels (returns `null`). `title` is the
dialog's title on Windows and its message line on macOS.

The platforms treat the owner differently:

- Windows: `IFileOpenDialog` with `FOS_PICKFOLDERS`, shown modal to the
  `owner` window: the owner is disabled while the dialog is open and the
  dialog stays in front of it. Pass `null` for an unowned dialog. COM
  failures throw `<step> failed: HRESULT 0x<code>`.
- macOS: an app-modal `NSOpenPanel` (`runModal`). It ignores `owner`, and
  activates the app first so the panel comes to the front. A window-modal
  sheet attached to the owner would be asynchronous, delivering its result
  in a completion block after the call returns, which cannot back a
  synchronous return value.

Because the dialog runs its own modal loop, call it from a
[`deferredUiMethods`](../app.md#startup-and-deferred-ui) handler when a page
triggers it. Deferral splits the call in two:

- The native binding callback that received the page's message returns
  immediately, before `pickFolder` opens, so the dialog's modal loop never
  runs inside the webview's message callback.
- On the next native tick the handler runs and the dialog opens. The page's
  RPC promise stays pending the whole time and resolves with the folder
  path, or with `null` when the user cancels.

## Clipboard

```ts
import { Clipboard } from "@n1h/sweetview/native";

Clipboard.writeText("Copied from Sweetview");
const text = Clipboard.readText(); // string, or null when there is no text
Clipboard.clear();
```

| Method | Meaning |
|---|---|
| `readText()` | The clipboard's text, or `null` when it holds no text representation. |
| `writeText(text)` | Replaces the whole clipboard with `text`. Other formats the previous owner put there (images, rich text) are cleared. |
| `clear()` | Empties the clipboard. |

All three are synchronous and run on the UI thread.

- Windows: Unicode text (`CF_UNICODETEXT`). Only one process can have the
  clipboard open at a time, and clipboard managers and remote-desktop
  clients often hold it briefly, so `OpenClipboard` is retried up to 5 times,
  5 ms apart, before throwing `sweetview: OpenClipboard failed (<code>)`.
  Sweetview opens it with a hidden window of its own so the new data has an
  owner. Allocation failures throw `GlobalAlloc`, `GlobalLock`,
  `SetClipboardData` or `EmptyClipboard` errors with the Win32 code.
- macOS: the general `NSPasteboard`, as UTF-8 plain text
  (`public.utf8-plain-text`). Writing clears the pasteboard first; a failed
  write throws `sweetview: NSPasteboard could not write text`.

## Reading files

These helpers read regular files with Node's `fs` and run on any OS Bun
supports, on any thread, including a worker. They exist for one purpose:
reading a path a user dropped or picked without trusting its size or type.
Each one refuses anything but a regular file (directories, devices, FIFOs),
and each enforces a byte limit.

| Need | Use |
|---|---|
| A text file | `readTextFile(path, { maxBytes?, encoding? })` |
| A whole binary file | `readFileBytes(path, { maxBytes? })` |
| Part of a large file, or a file read piece by piece | `openFileHandle`, `readFileChunk`, `closeFileHandle` |

### Whole files

A script that takes a text file and an image on the command line
(`bun run read.ts notes.txt photo.png`):

```ts
import { readFileBytes, readTextFile } from "@n1h/sweetview/native";

const [notesPath = "notes.txt", imagePath = "photo.png"] = process.argv.slice(2);

const notes = await readTextFile(notesPath);                                // UTF-8, at most 4 MiB
console.log(`${notesPath}: ${notes.split("\n").length} lines`);

const image = await readFileBytes(imagePath, { maxBytes: 64 * 1024 ** 2 }); // at most 64 MiB
await Bun.write(`${imagePath}.copy`, image);
console.log(`${imagePath}: copied ${image.byteLength} bytes`);
```

| Function | Returns | Default limit |
|---|---|---|
| `readTextFile(path, options?)` | `Promise<string>`; `encoding` is a Node `BufferEncoding`, default `"utf8"` | 4 MiB |
| `readFileBytes(path, options?)` | `Promise<Uint8Array>` | 32 MiB |

The limit is checked against the file's size before reading, and again while
reading, so a file that grows after the check is still refused.

### Chunked reads

A script that hashes a large file 1 MiB at a time without loading it whole
(`bun run hash.ts video.mp4`):

```ts
import { closeFileHandle, openFileHandle, readFileChunk } from "@n1h/sweetview/native";

const videoPath = process.argv[2] ?? "video.mp4";
const hasher = new Bun.CryptoHasher("sha256");

const { handleId, size } = openFileHandle(videoPath);
try {
  for (let offset = 0; offset < size; ) {
    const { data, bytesRead, eof } = readFileChunk(handleId, offset, 1024 * 1024);
    hasher.update(data);
    offset += bytesRead;
    if (eof || bytesRead === 0) break;
  }
} finally {
  closeFileHandle(handleId);
}
console.log(`${videoPath}: ${size} bytes, sha256 ${hasher.digest("hex")}`);
```

| Function | Meaning |
|---|---|
| `openFileHandle(path)` | Opens a regular file and returns `{ handleId, size }`. Synchronous. |
| `readFileChunk(handleId, offset, length)` | Reads up to `length` bytes (1 byte to 16 MiB) at `offset` and returns `{ data, bytesRead, eof }`. Synchronous and positional: it does not move a shared cursor, so reads can come in any order. `eof` is `true` when the read reached the end of the file. |
| `closeFileHandle(handleId)` | Closes one handle. Unknown IDs are ignored. |
| `closeAllFileHandles()` | Closes every handle the current thread opened; failures are collected into one `AggregateError`. |

Handle IDs are small opaque numbers, not file descriptors, so they can cross
IPC to a page safely. They belong to the thread that opened them: a worker
and the UI thread each have their own table, and an ID from one is invalid
on the other. Close handles in a `finally` block; nothing closes them for
you.

### Errors

| Condition | Error |
|---|---|
| `maxBytes` not a non-negative safe integer | `RangeError` `sweetview: maxBytes must be a non-negative safe integer` |
| The file is larger than `maxBytes` | `RangeError` `sweetview: <path> exceeds maxBytes (<n>)` |
| Not a regular file | `Error` `sweetview: expected a regular file at <path>` |
| Unknown or closed handle | `Error` `sweetview: invalid file handle <id>` |
| Bad `offset` | `RangeError` `sweetview: offset must be a non-negative safe integer` |
| Bad `length` | `RangeError` `sweetview: length must be a positive integer of at most 16 MiB` |
| Missing file, no permission | the Node `fs` error (`ENOENT`, `EACCES`, ...) |

On macOS and Linux files are opened with `O_NONBLOCK`, so a path that names a
FIFO is refused instead of blocking the thread forever.
