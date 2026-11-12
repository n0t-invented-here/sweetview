# sweetview workspace. The just modules mirror the folders: `just demos <app> <recipe>`
# for the apps (web-app, desktop-pet, menubar-only, menubar-notify), `just webview <recipe>` for the webview-bun /
# webview fork clones and the patched library built from them. `just demos` lists
# every app's recipes, `just demos <app>` one app's; `just --list <module>` works too.

# pwsh with errors terminating; a failing native command ends the recipe with its own exit code
set shell := ["pwsh", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true; trap { if ($_.Exception -is [System.Management.Automation.NativeCommandExitException]) { exit $_.Exception.ExitCode }; break };"]

mod demos
mod webview


# `just`: the recipes and modules here
@_default:
    just --justfile "{{justfile()}}" --list

# Dependencies for every workspace package and demo; the demos' own `install` runs this
install:
    bun install

typecheck:
    bun run typecheck

test:
    bun test

# Everything the branch must pass
check: typecheck test

# Every app: pages, executables and .app bundles, into each app's dist/
compile: demos::web-app::compile demos::desktop-pet::compile demos::menubar-only::compile demos::menubar-notify::compile

# Every app's build/ and dist/
clean: demos::web-app::clean demos::desktop-pet::clean demos::menubar-only::clean demos::menubar-notify::clean

# What `bun publish` would upload for @n1h/sweetview, without uploading
pack:
    bun pm pack --dry-run

# Publish @n1h/sweetview to npmjs (needs an npm login)
publish:
    bun publish --access public
