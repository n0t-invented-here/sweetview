# Real input for the webview's page behaviour and drops (DECISIONS D45), injected with SendInput
# so it travels through the OS as a person's does. Run by
# the runtime's engine tests (crates/sweetview-runtime/src/engine_tests.rs, `real_input`), one action per run:
#
#   -Action click -X <x> -Y <y>                      one left click at x,y
#   -Action ctrlwheel -X <x> -Y <y> [-Notches <n>]   Ctrl held, the wheel turned n notches up at x,y
#   -Action ctrlkey -X <x> -Y <y> -Key plus|minus|zero   a click at x,y (for the keyboard), then Ctrl+key
#   -Action drag -X <x> -Y <y> -ToX <x2> -ToY <y2>   the left button pressed at x,y, moved in steps
#                                                     to x2,y2 and released
#   -Action explorer -Folder <dir> -File <name> -ToX <x2> -ToY <y2>
#       opens an Explorer window on the folder, finds the file's item through UI Automation, presses
#       the left button on it, moves in steps to x2,y2 and releases; then closes that window
#
# Coordinates are physical screen pixels. It restores the cursor and never leaves a button or key
# down. Explorer's window belongs to the shell's own process (the explorer.exe started here hands the
# folder to it and exits), so the window is closed, not a process ended.
param(
  [Parameter(Mandatory = $true)][ValidateSet("click", "ctrlwheel", "ctrlkey", "drag", "explorer")][string]$Action,
  [int]$X, [int]$Y, [int]$ToX, [int]$ToY,
  [int]$Notches = 1,
  [ValidateSet("plus", "minus", "zero")][string]$Key = "plus",
  [string]$Folder, [string]$File,
  # Where the Explorer window is put (physical pixels, "x,y"), clear of the drop target.
  [string]$ExplorerAt = "40,120"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class RI {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEKEYBD u; }
  [StructLayout(LayoutKind.Explicit)] public struct MOUSEKEYBD {
    [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  public static string Under(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p); IntPtr root = GetAncestor(h, 2);
    var cls = new System.Text.StringBuilder(128); GetClassNameW(root, cls, 128);
    var title = new System.Text.StringBuilder(128); GetWindowTextW(root, title, 128);
    uint pid; GetWindowThreadProcessId(root, out pid);
    return "'" + title + "' (" + cls + ", pid " + pid + ")";
  }
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; Send(i); }
  public static void Move(int dx, int dy) { var i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.dwFlags = 0x0001; Send(i); }
  public static void KeyDown(ushort vk) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; Send(i); }
  public static void KeyUp(ushort vk) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = 2; Send(i); }
}
"@
# Physical pixels everywhere: per-monitor aware (v2), before any window or UI Automation call.
[RI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$LEFTDOWN = 0x0002; $LEFTUP = 0x0004; $WHEEL = 0x0800
$VK_CONTROL = 0x11
$keys = @{ plus = 0xBB; minus = 0xBD; zero = 0x30 }

function Move-To([int]$x, [int]$y, [int]$steps = 1) {
  # Relative moves in steps from where the cursor is, so whatever is under it sees the pointer travel.
  $p = New-Object RI+POINT
  [RI]::GetCursorPos([ref]$p) | Out-Null
  $sx = $p.X; $sy = $p.Y
  for ($i = 1; $i -le $steps; $i++) {
    $nx = [int]($sx + ($x - $sx) * $i / $steps); $ny = [int]($sy + ($y - $sy) * $i / $steps)
    [RI]::GetCursorPos([ref]$p) | Out-Null
    [RI]::Move($nx - $p.X, $ny - $p.Y)
    Start-Sleep -Milliseconds 25
  }
  [RI]::GetCursorPos([ref]$p) | Out-Null
  if ($p.X -ne $x -or $p.Y -ne $y) { [RI]::SetCursorPos($x, $y) | Out-Null }
}
function Drag([int]$fromX, [int]$fromY, [int]$toX, [int]$toY) {
  [RI]::SetCursorPos($fromX - 2, $fromY) | Out-Null
  Start-Sleep -Milliseconds 100
  Move-To $fromX $fromY 2
  Start-Sleep -Milliseconds 250
  [RI]::Mouse($LEFTDOWN, 0)
  Start-Sleep -Milliseconds 150
  # A few pixels first: OLE and HTML drags start once the pointer leaves the drag rectangle.
  Move-To ($fromX + 6) ($fromY + 6) 3
  Start-Sleep -Milliseconds 200
  Move-To $toX $toY 40
  Start-Sleep -Milliseconds 300
  Move-To ($toX + 2) ($toY + 2) 2
  Start-Sleep -Milliseconds 300
  [RI]::Mouse($LEFTUP, 0)
  "pressed at $fromX,$fromY (on $([RI]::Under($fromX, $fromY))), moved in steps to $toX,$toY (on $([RI]::Under($toX, $toY))), released"
}

$saved = New-Object RI+POINT
[RI]::GetCursorPos([ref]$saved) | Out-Null
$explorerWindow = $null
try {
  switch ($Action) {
    "ctrlwheel" {
      [RI]::SetCursorPos($X - 2, $Y) | Out-Null
      Move-To $X $Y 2
      Start-Sleep -Milliseconds 200
      [RI]::KeyDown($VK_CONTROL)
      Start-Sleep -Milliseconds 80
      for ($n = 0; $n -lt $Notches; $n++) { [RI]::Mouse($WHEEL, 120); Start-Sleep -Milliseconds 120 }
      [RI]::KeyUp($VK_CONTROL)
      "Ctrl held, the wheel turned $Notches notch(es) up at $X,$Y (on $([RI]::Under($X, $Y)))"
    }
    "ctrlkey" {
      [RI]::SetCursorPos($X - 2, $Y) | Out-Null
      Move-To $X $Y 2
      Start-Sleep -Milliseconds 150
      [RI]::Mouse($LEFTDOWN, 0); Start-Sleep -Milliseconds 60; [RI]::Mouse($LEFTUP, 0)
      Start-Sleep -Milliseconds 300
      [RI]::KeyDown($VK_CONTROL); Start-Sleep -Milliseconds 60
      [RI]::KeyDown([uint16]$keys[$Key]); Start-Sleep -Milliseconds 60
      [RI]::KeyUp([uint16]$keys[$Key]); Start-Sleep -Milliseconds 60
      [RI]::KeyUp($VK_CONTROL)
      "clicked at $X,$Y (on $([RI]::Under($X, $Y))), then Ctrl+$Key"
    }
    "click" {
      [RI]::SetCursorPos($X - 2, $Y) | Out-Null
      Move-To $X $Y 2
      Start-Sleep -Milliseconds 200
      [RI]::Mouse($LEFTDOWN, 0); Start-Sleep -Milliseconds 60; [RI]::Mouse($LEFTUP, 0)
      "clicked at $X,$Y (on $([RI]::Under($X, $Y)))"
    }
    "drag" { Drag $X $Y $ToX $ToY }
    "explorer" {
      if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { throw "-Folder: no such folder" }
      $leaf = Split-Path -Leaf $Folder
      $auto = [System.Windows.Automation.AutomationElement]
      $tree = [System.Windows.Automation.TreeScope]
      $started = Start-Process -FilePath "explorer.exe" -ArgumentList "`"$Folder`"" -PassThru
      "explorer.exe started for the folder (pid $($started.Id)); waiting for its window"
      $cabinet = New-Object System.Windows.Automation.PropertyCondition($auto::ClassNameProperty, "CabinetWClass")
      for ($i = 0; $i -lt 100 -and -not $explorerWindow; $i++) {
        Start-Sleep -Milliseconds 100
        foreach ($w in $auto::RootElement.FindAll($tree::Children, $cabinet)) {
          try { if ($w.Current.Name -like "*$leaf*") { $explorerWindow = $w; break } } catch {}
        }
      }
      if (-not $explorerWindow) { throw "no Explorer window on the folder appeared" }
      $at = $ExplorerAt.Split(",") | ForEach-Object { [double]$_ }
      try {
        $move = $explorerWindow.GetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern)
        $move.Resize(640, 460); $move.Move($at[0], $at[1])
        Start-Sleep -Milliseconds 400
      } catch { "the Explorer window could not be moved: $_" }
      $r = $explorerWindow.Current.BoundingRectangle
      "Explorer window '$($explorerWindow.Current.Name)' at $([int]$r.Left),$([int]$r.Top) size $([int]$r.Width)x$([int]$r.Height)"
      $base = [System.IO.Path]::GetFileNameWithoutExtension($File)
      $item = $null
      $listItem = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
      for ($i = 0; $i -lt 50 -and -not $item; $i++) {
        Start-Sleep -Milliseconds 100
        foreach ($e in $explorerWindow.FindAll($tree::Descendants, $listItem)) {
          try { if ($e.Current.Name -eq $File -or $e.Current.Name -eq $base) { $item = $e; break } } catch {}
        }
      }
      if (-not $item) { throw "the file's item was not found in the Explorer window" }
      $ir = $item.Current.BoundingRectangle
      $ix = [int]($ir.Left + [Math]::Min(24, $ir.Width / 2)); $iy = [int]($ir.Top + $ir.Height / 2)
      "the file's item '$($item.Current.Name)' at $([int]$ir.Left),$([int]$ir.Top) size $([int]$ir.Width)x$([int]$ir.Height)"
      Drag $ix $iy $ToX $ToY
      Start-Sleep -Milliseconds 500
    }
  }
} finally {
  # Never leave a button or key down; put the cursor back; close the Explorer window opened here.
  if ([RI]::GetAsyncKeyState(0x01) -lt 0) { [RI]::Mouse($LEFTUP, 0) }
  if ([RI]::GetAsyncKeyState($VK_CONTROL) -lt 0) { [RI]::KeyUp($VK_CONTROL) }
  [RI]::SetCursorPos($saved.X, $saved.Y) | Out-Null
  if ($explorerWindow) {
    try {
      $explorerWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
      "the Explorer window was closed"
    } catch { "the Explorer window could not be closed: $_" }
  }
  if ($started -and -not $started.HasExited) {
    Stop-Process -Id $started.Id
    "explorer.exe pid $($started.Id) ended by its id"
  }
}
