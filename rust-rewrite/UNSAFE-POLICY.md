# Unsafe code policy

The rewrite moves native code out of TypeScript `bun:ffi` and into well-organised Rust. Rust that wraps every call in `unsafe` and passes raw handles around is the same code in a different file, and it does not meet requirement R4.

## Order of preference

For each behaviour, take the first that provides it:

1. A safe API of `tao`, `wry`, `muda`, `tray-icon` or `rfd`.
2. A safe method of an `objc2` framework crate, or a safe wrapper type of the `windows` crate. Most AppKit methods in `objc2-app-kit` are safe; `SWEETVIEW-RESTART-PROPOSAL.md` lists the ones this project needs with their safety.
3. An addition to this project's `wry` fork, written in the style of the code around it.
4. An `unsafe` block in one of this project's platform crates, under the rules below.

Record the choice for anything that lands on 3 or 4 in `rust-rewrite/UNSAFE-LEDGER.md`: the behaviour, the crate API that was looked for and its docs.rs page, and why it does not serve.

## Where `unsafe` may appear

| Crate | `unsafe` |
|---|---|
| a platform crate: `crates/sweetview-platform`, or `crates/sweetview-platform-<name>` when the work is split (per OS, or input hooks apart from windows) | allowed, under the rules below |
| every other crate in the workspace | forbidden: `#![forbid(unsafe_code)]` at the crate root |
| the fork | as its upstream code does it |

How many crates there are and where their boundaries fall is a design choice of the work: a crate has one job a maintainer can name in a sentence. What is fixed is that `unsafe` stays inside crates whose name starts with `sweetview-platform`, because `verify.ts` and a reviewer find it by that name.

The N-API surface, the registries, the callback plumbing, the hit-region logic, the menu data, header validation and every other piece of logic live outside the platform crates and compile with `unsafe` forbidden.

## Rules inside a platform crate

- The crate root sets `#![deny(unsafe_op_in_unsafe_fn)]`, `#![deny(clippy::undocumented_unsafe_blocks)]`, `#![deny(clippy::multiple_unsafe_ops_per_block)]` and `#![deny(clippy::missing_safety_doc)]`.
- The crate's public API has no `unsafe fn` and no raw pointer or raw handle in a signature. Other crates call safe functions and hold owning types.
- An `unsafe` block holds one operation: one foreign call, or one pointer conversion.
- Each block has a `// SAFETY:` comment that names the invariant and says what guarantees it here. "The handle is valid" is not a guarantee; "`self.hwnd` is owned by this `OwnedWindow` and destroyed only in its `Drop`" is.
- The guarantee comes from types, not from callers being careful:
  - Each OS resource has an owning type whose `Drop` releases it: windows, hooks, icons, menus, GDI objects, timers, COM registrations, event taps, run-loop sources. No bare `HWND`, `HHOOK`, `HICON` or pointer is stored in a struct that does not own it, except as a borrowed type with a lifetime.
  - Types that must stay on the UI thread are not `Send` and not `Sync`. AppKit entry points take a `MainThreadMarker`.
  - A callback the OS holds is owned by the object that registered it and is unregistered in that object's `Drop` before its memory goes.
  - Buffers passed to the OS are owned Rust values for the whole call. Lengths come from the buffer, never from a second variable.
- Callbacks from the OS (`extern "system"` and `extern "C"` functions, Objective-C methods) never unwind: their bodies run inside `std::panic::catch_unwind` and convert a panic to the callback's failure value.
- Struct layouts come from the `windows` and `objc2` crates. No hand-written offsets, no byte arrays standing in for structs.
- No `transmute`. No `static mut`. Global state is `OnceLock`, `thread_local!`, or a field of an owning type.

## Tests

- Logic that was split out of an `unsafe` function is tested as safe code.
- Each owning type has a test that creates and drops it in a loop and asserts that the process's handle count (Windows: `GetGuiResources` and `GetProcessHandleCount`) returns to its starting value.
- Code that can run under Miri does: `cargo miri test` for the crates with `unsafe` forbidden, as a guard on their dependencies' use.

## The ledger

`rust-rewrite/UNSAFE-LEDGER.md` is rewritten by `bun rust-rewrite/verify.ts <platform> --ledger`: one row per file that contains `unsafe`, with the block count. A count that rises in a commit is explained in that commit's message.

## Review

Before the goal completes, a reviewer that did not write the code reads every `unsafe` block against this file. The checklist's last item records the result.
