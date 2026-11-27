# The just modules mirror the folders: demos/ for the apps, webview/ for the webview-bun and
# webview fork clones and the patched library built from them.

set shell := ["pwsh", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true; trap { if ($_.Exception -is [System.Management.Automation.NativeCommandExitException]) { exit $_.Exception.ExitCode }; break };"]

mod demos
mod webview


@_default:
    just --justfile "{{justfile()}}" --list

install:
    bun install

# Builds the Rust binding for this machine into packages/sweetview-native/prebuilt/, where the
# native package loads it from, and regenerates its TypeScript declarations from the Rust.
native: install
    bunx napi build --platform --release --cwd packages/sweetview-native --manifest-path ../../crates/sweetview-platform-node/Cargo.toml --output-dir prebuilt --no-js --dts binding.d.ts

typecheck: install
    bun run typecheck

test: install
    bun test

# The binding is built first: the typecheck reads its generated declarations and the tests load it.
check: native typecheck test

compile: demos::web-app::compile demos::desktop-pet::compile demos::menubar-only::compile demos::menubar-notify::compile

clean: demos::web-app::clean demos::desktop-pet::clean demos::menubar-only::clean demos::menubar-notify::clean demos::native-tabs::clean

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
    foreach ($package in @('sweetview-ipc', 'sweetview-ipc-ws', 'sweetview-settings', 'sweetview-native', 'sweetview-build', 'sweetview')) {
        Push-Location (Join-Path packages $package)
        try { bun publish --access public } finally { Pop-Location }
    }
