# Reads a notification icon back from the shell, for the tray tests: the tooltip Explorer shows
# for it (its UI Automation name, which is the tooltip, or a name the shell keeps for the icon, a
# space and the current tooltip) and the colour of the middle pixel of the image it draws.
#
#   pwsh -NoProfile -File tray-shell.ps1 -Tooltip <text>
#
# Prints one JSON line: {"found":true,"name":...,"where":...,"pixel":[r,g,b],"rect":[x,y,w,h]},
# {"found":false,"where":...} or {"skip":"<why>"}.
#
# The icon is looked for in the taskbar's notification area and, when it is not there, in the
# overflow flyout. The flyout exists only while it is open, and only a click opens it, so the
# script clicks its chevron with SendInput, the way the W5.5 check (rust-rewrite/checks/
# tray-real-click.ps1) does, and clicks it again to close it. It clicks only when no mouse button
# is down and the window under the chevron is the taskbar's own; otherwise it reports a skip,
# because another session on the shared desktop is using the mouse. It puts the cursor back and
# never leaves a button down.
param([Parameter(Mandatory = $true)][string]$Tooltip)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class TS {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
  public static void Mouse(uint flags) { var i = new INPUT[1]; i[0].type = 0; i[0].mi.dwFlags = flags; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  public static void Nudge() { var i = new INPUT[1]; i[0].type = 0; i[0].mi.dx = 1; i[0].mi.dwFlags = 1; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  public static bool ButtonsDown() { return GetAsyncKeyState(1) < 0 || GetAsyncKeyState(2) < 0 || GetAsyncKeyState(4) < 0; }
  public static string RootClassAt(int x, int y) {
    POINT p; p.X = x; p.Y = y; var sb = new StringBuilder(128); GetClassNameW(GetAncestor(WindowFromPoint(p), 2), sb, 128); return sb.ToString();
  }
  public static uint Pixel(int x, int y) { var dc = GetDC(IntPtr.Zero); try { return GetPixel(dc, x, y); } finally { ReleaseDC(IntPtr.Zero, dc); } }
}
"@
$auto = [System.Windows.Automation.AutomationElement]
$tree = [System.Windows.Automation.TreeScope]
function Top-Window($class) {
  $auto::RootElement.FindFirst($tree::Children, (New-Object System.Windows.Automation.PropertyCondition($auto::ClassNameProperty, $class)))
}
function Find-Icon($root) {
  if (-not $root) { return $null }
  foreach ($e in $root.FindAll($tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try { $name = $e.Current.Name; if ($name -eq $Tooltip -or $name.EndsWith(" $Tooltip")) { return $e } } catch {}
  }
  return $null
}
function Report($icon, $where) {
  $r = $icon.Current.BoundingRectangle
  $cx = [int]($r.Left + $r.Width / 2); $cy = [int]($r.Top + $r.Height / 2)
  $c = [TS]::Pixel($cx, $cy)
  [ordered]@{ found = $true; name = $icon.Current.Name; where = $where; pixel = @(($c -band 0xff), (($c -shr 8) -band 0xff), (($c -shr 16) -band 0xff)); rect = @([int]$r.Left, [int]$r.Top, [int]$r.Width, [int]$r.Height) } | ConvertTo-Json -Compress
}
function Click-Chevron($chevron) {
  $r = $chevron.Current.BoundingRectangle
  $x = [int]($r.Left + $r.Width / 2); $y = [int]($r.Top + $r.Height / 2)
  if ([TS]::ButtonsDown()) { return "a mouse button was already down on the shared desktop" }
  [TS]::SetCursorPos($x - 1, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [TS]::Nudge()
  Start-Sleep -Milliseconds 150
  $under = [TS]::RootClassAt($x, $y)
  if ($under -ne "Shell_TrayWnd") { return "another window ($under) is over the overflow chevron" }
  if ([TS]::ButtonsDown()) { return "a mouse button was already down on the shared desktop" }
  [TS]::Mouse(0x0002); Start-Sleep -Milliseconds 60; [TS]::Mouse(0x0004)
  return ""
}

$saved = New-Object TS+POINT
[TS]::GetCursorPos([ref]$saved) | Out-Null
$opened = $null
try {
  $taskbar = Top-Window "Shell_TrayWnd"
  if (-not $taskbar) { @{ skip = "no taskbar (Shell_TrayWnd) in this session" } | ConvertTo-Json -Compress; return }
  $icon = Find-Icon $taskbar
  if ($icon) { Report $icon "taskbar"; return }
  $chevron = $null
  foreach ($e in $taskbar.FindAll($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))) {
    try { if ($e.Current.AutomationId -eq "SystemTrayIcon" -and $e.Current.ClassName -eq "SystemTray.NormalButton") { $chevron = $e; break } } catch {}
  }
  if (-not $chevron) { @{ found = $false; where = "taskbar, and no overflow chevron" } | ConvertTo-Json -Compress; return }
  $flyout = Top-Window "TopLevelWindowForOverflowXamlIsland"
  $icon = Find-Icon $flyout
  if (-not ($icon -and $icon.Current.BoundingRectangle.Width -gt 0 -and -not $icon.Current.IsOffscreen)) {
    $why = Click-Chevron $chevron
    if ($why) { @{ skip = $why } | ConvertTo-Json -Compress; return }
    $opened = $chevron
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 100
      $icon = Find-Icon (Top-Window "TopLevelWindowForOverflowXamlIsland")
      if ($icon -and $icon.Current.BoundingRectangle.Width -gt 0) { break }
    }
  }
  if (-not $icon) { @{ found = $false; where = "taskbar and overflow flyout" } | ConvertTo-Json -Compress; return }
  # The flyout fades in: let it finish before the pixel is read.
  Start-Sleep -Milliseconds 400
  Report $icon "overflow"
} finally {
  if ($opened) { Click-Chevron $opened | Out-Null }
  [TS]::SetCursorPos($saved.X, $saved.Y) | Out-Null
}
