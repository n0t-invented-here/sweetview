# sweetview-platform-node

Job: the export table of the binding, the items that carry the `#[napi]` attribute.

This crate builds to `sweetview.<target>.node`, which `packages/sweetview-native` loads with `require`. Its TypeScript declarations are generated from the signatures here.

Every item is a forward: one `#[napi]` function or method whose body is a single call into `sweetview-napi`, where the behaviour lives under `#![forbid(unsafe_code)]`. Nothing is decided here.

It is a platform crate for one reason: the `#[napi]` attribute expands to `unsafe extern "C"` trampolines and a load-time registration, which a crate that forbids `unsafe` cannot contain. This crate has no hand-written `unsafe`; `rust-rewrite/DECISIONS.md` records the split.
