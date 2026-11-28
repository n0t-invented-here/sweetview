# The just modules mirror the folders: demos/ for the apps, native for packages/sweetview-native/
# and the Rust binding it loads, webview/ for the webview-bun and webview fork clones and the
# patched library built from them.

set shell := ["pwsh", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true; trap { if ($_.Exception -is [System.Management.Automation.NativeCommandExitException]) { exit $_.Exception.ExitCode }; break };"]

mod demos
mod native "packages/sweetview-native/justfile"
mod webview


@_default:
    just --justfile "{{justfile()}}" --list

install:
    bun install

typecheck: install
    bun run typecheck

# On Windows the tests load the binding, so it is built first (`just native build`).
test: install native::_build-if-windows
    bun test

# The binding is built first: the typecheck reads its generated declarations and the tests load it.
check: native::build typecheck test

compile: demos::web-app::compile demos::desktop-pet::compile demos::menubar-only::compile demos::menubar-notify::compile

clean: demos::web-app::clean demos::web-app-electron::clean demos::web-app-tauri::clean demos::desktop-pet::clean demos::menubar-only::clean demos::menubar-notify::clean demos::native-tabs::clean

# The native package ships the binding, so it is built first.
[script("pwsh", "-NoProfile", "-File")]
pack: native::build
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $true
    foreach ($package in Get-ChildItem packages -Directory) {
        if (!(Test-Path (Join-Path $package.FullName 'package.json'))) { continue }
        Push-Location $package.FullName
        try { bun pm pack --dry-run } finally { Pop-Location }
    }

# The native package ships the binding, so it is built first. See docs/local-checkout.md.
# Registers this checkout's eight packages with `bun link`, for an application elsewhere to run against
[script("pwsh", "-NoProfile", "-File")]
link: native::build
    $ErrorActionPreference = 'Stop'
    $names = foreach ($package in Get-ChildItem packages -Directory) {
        if (!(Test-Path (Join-Path $package.FullName 'package.json'))) { continue }
        $output = bun link --cwd $package.FullName 2>&1
        if ($LASTEXITCODE -ne 0) { $output | ForEach-Object { [Console]::Error.WriteLine($_) }; exit $LASTEXITCODE }
        (Get-Content (Join-Path $package.FullName 'package.json') -Raw | ConvertFrom-Json).name
    }
    Write-Output "just link: registered $($names.Count) packages of this checkout with bun link ($($names -join ', ')); in an application, run 'just link-sweetview' (docs/local-checkout.md)."

# A name is removed whichever checkout registered it.
# Unregisters the eight package names from `bun link`
[script("pwsh", "-NoProfile", "-File")]
unlink:
    $ErrorActionPreference = 'Stop'
    $names = foreach ($package in Get-ChildItem packages -Directory) {
        if (!(Test-Path (Join-Path $package.FullName 'package.json'))) { continue }
        $output = bun unlink --cwd $package.FullName 2>&1
        if ($LASTEXITCODE -ne 0) { $output | ForEach-Object { [Console]::Error.WriteLine($_) }; exit $LASTEXITCODE }
        (Get-Content (Join-Path $package.FullName 'package.json') -Raw | ConvertFrom-Json).name
    }
    Write-Output "just unlink: unregistered $($names.Count) packages ($($names -join ', ')); in an application still linked, run 'just unlink-sweetview' first, or its next bun install fails."

[script("pwsh", "-NoProfile", "-File")]
publish: native::build
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $true
    foreach ($package in @('sweetview-ipc', 'sweetview-ipc-ws', 'sweetview-ipc-electron', 'sweetview-ipc-tauri', 'sweetview-settings', 'sweetview-native', 'sweetview-build', 'sweetview')) {
        Push-Location (Join-Path packages $package)
        try { bun publish --access public } finally { Pop-Location }
    }
