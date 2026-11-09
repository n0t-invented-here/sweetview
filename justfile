# sweetview workspace. The just modules mirror the folders: `just demos <app> <recipe>`
# for the apps (web-app, desktop-pet), `just webview <recipe>` for the webview-bun /
# webview fork clones and the patched library built from them. `just --list <module>`
# lists what is under it.

set shell := ["pwsh", "-NoProfile", "-Command"]

mod demos
mod webview

chk := '; if ($LASTEXITCODE) { exit $LASTEXITCODE }'


install:
    bun install {{chk}}

typecheck:
    bun run typecheck {{chk}}

test:
    bun test {{chk}}

# Everything the branch must pass
check: typecheck test

# Both apps: pages, executables and .app bundles, into each app's dist/
compile: demos::web-app::compile demos::desktop-pet::compile

# Both apps' build/ and dist/
clean: demos::web-app::clean demos::desktop-pet::clean

# What `bun publish` would upload for @n1h/sweetview, without uploading
pack:
    bun pm pack --dry-run {{chk}}

# Publish @n1h/sweetview to npmjs (needs an npm login)
publish:
    bun publish --access public {{chk}}
