# The just modules mirror the folders: demos/ for the apps, webview/ for the webview-bun and
# webview fork clones and the patched library built from them.

set shell := ["pwsh", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true; trap { if ($_.Exception -is [System.Management.Automation.NativeCommandExitException]) { exit $_.Exception.ExitCode }; break };"]

mod demos
mod webview


@_default:
    just --justfile "{{justfile()}}" --list

install:
    bun install

typecheck:
    bun run typecheck

test:
    bun test

check: typecheck test

compile: demos::web-app::compile demos::desktop-pet::compile demos::menubar-only::compile demos::menubar-notify::compile

clean: demos::web-app::clean demos::desktop-pet::clean demos::menubar-only::clean demos::menubar-notify::clean

pack:
    bun pm pack --dry-run

publish:
    bun publish --access public
