# sweetview-shell-data

Job: the data the shell integrations and notifications write, read and check, built and checked without an OS call.

That is the names, limits and wire formats of a single instance, the registry values of a URL scheme, the text the clipboard holds, the toast XML and an application id, and the errors these report. The platform crates (`sweetview-platform-shell`, `sweetview-platform-notify`) make the OS calls and use these functions for everything around them; they re-export what their own callers name.

It makes no OS call and holds no `unsafe` (`#![forbid(unsafe_code)]`), so every rule is tested with `cargo test` on any machine (decision D47 in `rust-rewrite/DECISIONS.md`).
