# sweetview-platform-node

Job: the export table of the binding, the items that carry the `#[napi]` attribute.

This crate builds to `sweetview.<target>.node`, which `packages/sweetview-native` loads with `require`. Its TypeScript declarations are generated from the signatures here.

Every item is a forward: one `#[napi]` function or method whose body is a single call into `sweetview-napi`, where the behaviour lives under `#![forbid(unsafe_code)]`. Nothing is decided here: the object shapes and their conversions are `sweetview_napi::objects`, re-exported by `types.rs`.

Every entry point carries `catch_unwind` (`#[napi(catch_unwind)]`, napi-derive 3.7.2), so a panic in the runtime reached from JavaScript becomes a JavaScript exception with the panic's message instead of ending the process.

Items documented "Test hook" (the `debug*` methods of `Notifier`, `Engine.movesTold`) exist for the tests, which run against the binding that ships.

It is a platform crate for one reason: the `#[napi]` attribute expands to `unsafe extern "C"` trampolines and a load-time registration, which a crate that forbids `unsafe` cannot contain. This crate has no hand-written `unsafe`; `rust-rewrite/DECISIONS.md` records the split.
