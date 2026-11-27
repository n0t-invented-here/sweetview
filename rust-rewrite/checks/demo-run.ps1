# Runs one demo scenario with real input and prints what was seen (checklist items W1.6, W4.7, W5.5).
#
#   pwsh -NoProfile -File rust-rewrite/checks/demo-run.ps1 -Scenario <name>
#
# Scenarios: alone-menubar-only, alone-web-app (a compiled executable copied alone into a new empty
# folder under the temp directory and run from there), pet-compiled, pet-source, web-app-source,
# menubar-only-source, menubar-only-compiled, menubar-notify-compiled. The compiled ones need
# `just compile` first. Tray icons and the toast are clicked with injected mouse input
# (tray-real-click.ps1, toast-real-click.ps1 beside this file); every process this script starts
# is ended by its own id if it does not exit by itself. Nothing here is a hand's click.
param([Parameter(Mandatory = $true)][string]$Scenario)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$checks = "$repo\rust-rewrite\checks"
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class DE {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // A visible top-level window with this title, owned by one of the given processes.
  public static IntPtr Find(string title, uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); uint p; GetWindowThreadProcessId(h, out p);
      if (sb.ToString() == title && Array.IndexOf(pids, p) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

function New-EmptyFolder {
  $dir = Join-Path $env:TEMP ("sv-alone-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $dir | Out-Null
  $dir
}
function Start-Demo($exe, $argList, $dir) {
  $a = @{}; if ($argList) { $a.ArgumentList = $argList }
  $script:errFile = Join-Path $env:TEMP "sv-demo.err"; $script:outFile = Join-Path $env:TEMP "sv-demo.out"
  Start-Process -FilePath $exe @a -WorkingDirectory $dir -PassThru -WindowStyle Hidden -RedirectStandardError $script:errFile -RedirectStandardOutput $script:outFile
}
function Pids($p) {
  # The process and everything it started (bun run starts the app as a child of a child), without WebView2's own.
  $all = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'msedgewebview2.exe' })
  $ids = New-Object System.Collections.Generic.List[uint32]; $ids.Add([uint32]$p.Id)
  for ($i = 0; $i -lt $ids.Count; $i++) { foreach ($c in $all) { if ($c.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([uint32]$c.ProcessId)) { $ids.Add([uint32]$c.ProcessId) } } }
  [uint32[]]$ids.ToArray()
}
function Wait-Window($title, $p, $seconds = 20) {
  for ($i = 0; $i -lt $seconds * 5; $i++) { $h = [DE]::Find($title, (Pids $p)); if ($h -ne [IntPtr]::Zero) { return $true }; Start-Sleep -Milliseconds 200 }
  $false
}
function Tray($tooltip, $p, $action = "menu", $keys = "Up,Return") {
  foreach ($id in (Pids $p)) {
    $out = & pwsh -NoProfile -File "$checks\tray-real-click.ps1" -Tooltip $tooltip -ProcessId $id -Action $action -Keys $keys 2>&1
    if ($LASTEXITCODE -eq 0) { $out; return }
    $last = $out
  }
  $last; throw "the tray click failed for every process of the app"
}
function Finish($p, $seconds = 10) {
  if ($p.WaitForExit($seconds * 1000)) { "app exit code: $($p.ExitCode)" } else { "the app did not exit" }
  $err = (Get-Content $script:errFile -Raw); "stderr: " + ($(if ($err) { $err.Trim() } else { "(empty)" }))
}
function Guard($p, [scriptblock]$body) {
  try { & $body } catch { "FAILED: $_" } finally { if (-not $p.HasExited) { "ending the process this script started"; Stop-Process -Id $p.Id -Force } }
}

switch ($Scenario) {
  "alone-menubar-only" {
    $dir = New-EmptyFolder
    Copy-Item "$repo\demos\menubar-only\dist\menubar-only-windows-x64.exe" $dir
    "files in the folder: $((Get-ChildItem $dir).Name -join ', ')"
    $env:DRIVE_LOG = Join-Path $env:TEMP "sv-drive-log.txt"
    & bun "$repo\demos\menubar-only\scripts\tray-drive.ts" $dir (Join-Path $dir "menubar-only-windows-x64.exe") 2>&1
    "tray-drive exit code: $LASTEXITCODE"
  }
  "alone-web-app" {
    $dir = New-EmptyFolder
    Copy-Item "$repo\demos\web-app\dist\web-app-windows-x64.exe" $dir
    "files in the folder: $((Get-ChildItem $dir).Name -join ', ')"
    $p = Start-Demo (Join-Path $dir "web-app-windows-x64.exe") $null $dir
    Guard $p {
      "window titled 'Web App' on screen: $(Wait-Window 'Web App' $p)"
      "--- scripts/tray-click-probe.ps1 (the shell's click messages posted to the tray icon's window)"
      & pwsh -NoProfile -File "$repo\demos\web-app\scripts\tray-click-probe.ps1" 2>&1
      "--- real right click on the tray icon; Up, Return chooses the menu's last item (Quit Web App)"
      Tray "Web App" $p
      Finish $p
    }
  }
  "pet-compiled" {
    $d = "$repo\demos\desktop-pet"
    $p = Start-Demo "$d\dist\desktop-pet-windows-x64.exe" $null $d
    Guard $p {
      "window titled 'Pet' on screen: $(Wait-Window 'Pet' $p 30)"
      Start-Sleep -Seconds 3
      "--- scripts/probe.ps1 (real input: which window the OS hands a click to, then a drag)"
      & pwsh -NoProfile -File "$d\scripts\probe.ps1" -Title Pet 2>&1
      "--- real right click on the tray icon; Up, Return chooses the menu's last item (Quit Pet)"
      Tray "Pet" $p
      Finish $p
    }
  }
  "pet-source" {
    $d = "$repo\demos\desktop-pet"
    $p = Start-Demo "bun" @("run", "app.ts") $d
    Guard $p {
      "window titled 'Pet' on screen: $(Wait-Window 'Pet' $p 30)"
      Start-Sleep -Seconds 2
      "--- real right click on the tray icon; Up, Return chooses the menu's last item (Quit Pet)"
      Tray "Pet" $p
      Finish $p
    }
  }
  "web-app-source" {
    $d = "$repo\demos\web-app"
    $p = Start-Demo "bun" @("run", "app.ts") $d
    Guard $p {
      "window titled 'Web App' on screen: $(Wait-Window 'Web App' $p 30)"
      "--- real left click on the tray icon (the demo toggles its window)"
      Tray "Web App" $p "click"
      Start-Sleep -Milliseconds 1500
      "window on screen after the click: $([DE]::Find('Web App', (Pids $p)) -ne [IntPtr]::Zero)"
      "--- real right click on the tray icon; Up, Return chooses the menu's last item (Quit Web App)"
      Tray "Web App" $p
      Finish $p
    }
  }
  "menubar-only-source" {
    $d = "$repo\demos\menubar-only"
    $p = Start-Demo "bun" @("run", "app.ts") $d
    Guard $p {
      Start-Sleep -Seconds 4
      "--- real right click on the tray icon; Up, Up, Return chooses 'Clock in Tooltip'"
      Tray "Menubar Only" $p "menu" "Up,Up,Return"
      Start-Sleep -Seconds 3
      "--- real right click again (the icon's name now carries the time); Up, Return chooses 'Quit Menubar Only'"
      Tray "Menubar Only" $p
      Finish $p
    }
  }
  "menubar-only-compiled" {
    $d = "$repo\demos\menubar-only"
    $p = Start-Demo "$d\dist\menubar-only-windows-x64.exe" $null $d
    Guard $p {
      Start-Sleep -Seconds 4
      "--- real right click on the tray icon; Up, Return chooses 'Quit Menubar Only'"
      Tray "Menubar Only" $p
      Finish $p
    }
  }
  "menubar-notify-compiled" {
    $d = "$repo\demos\menubar-notify"
    $log = Join-Path $env:LOCALAPPDATA "menubar-notify.log"
    $before = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
    $p = Start-Demo "$d\dist\menubar-notify-windows-x64.exe" $null $d
    Guard $p {
      Start-Sleep -Seconds 6
      "--- real right click on the tray icon; Up, Up, Up, Return chooses 'Send Notification Now'"
      Tray "Menubar Notify" $p "menu" "Up,Up,Up,Return"
      "--- real left click on the toast banner"
      & pwsh -NoProfile -File "$checks\toast-real-click.ps1" -Title "Menubar Notify" 2>&1
      Start-Sleep -Seconds 2
      "--- real right click on the tray icon; Up, Return chooses 'Quit Menubar Notify'"
      Tray "Menubar Notify" $p
      Finish $p
    }
    "--- the app's own log for this run"
    Get-Content $log | Select-Object -Skip $before | ForEach-Object { $_ -replace [regex]::Escape($env:LOCALAPPDATA), '<LOCALAPPDATA>' }
  }
  default { throw "unknown scenario $Scenario" }
}
