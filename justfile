# The just modules mirror the folders: demos/ for the apps, webview/ for the webview-bun and
# webview fork clones and the patched library built from them.

set shell := ["pwsh", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true; trap { if ($_.Exception -is [System.Management.Automation.NativeCommandExitException]) { exit $_.Exception.ExitCode }; break };"]

mod demos
mod webview


@_default:
    just --justfile "{{justfile()}}" --list

install:
    bun install

typecheck: install
    bun run typecheck

test: install
    bun test

check: typecheck test

compile: demos::web-app::compile demos::desktop-pet::compile demos::menubar-only::compile demos::menubar-notify::compile

clean: demos::web-app::clean demos::web-app-electron::clean demos::web-app-tauri::clean demos::desktop-pet::clean demos::menubar-only::clean demos::menubar-notify::clean demos::native-tabs::clean

[script("pwsh", "-NoProfile", "-File")]
pack:
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $true
    foreach ($package in Get-ChildItem packages -Directory) {
        if (!(Test-Path (Join-Path $package.FullName 'package.json'))) { continue }
        Push-Location $package.FullName
        try { bun pm pack --dry-run } finally { Pop-Location }
    }

[script("pwsh", "-NoProfile", "-File")]
publish:
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $true
    foreach ($package in @('sweetview-ipc', 'sweetview-ipc-ws', 'sweetview-ipc-electron', 'sweetview-ipc-tauri', 'sweetview-settings', 'sweetview-native', 'sweetview-build', 'sweetview')) {
        Push-Location (Join-Path packages $package)
        try { bun publish --access public } finally { Pop-Location }
    }
