# Clicks a running app's tray icon with real mouse input (checklist item W5.5).
#
#   pwsh -NoProfile -File rust-rewrite/checks/tray-real-click.ps1 -Tooltip "Menubar Only" -ProcessId <pid> [-Action menu|click|double]
#
# The icon is found through UI Automation by its tooltip, in the taskbar's notification area or,
# when it sits there, in the overflow flyout (opened by a real click on its chevron). The cursor
# is moved onto the icon and the click is injected with SendInput, so it travels through Explorer
# exactly as a person's does: the shell posts the icon's callback message to the app.
#
#   -Action menu (the default): a right click; the script waits for the app's popup menu, then
#     presses -Keys, key names separated by commas (Up, Down, Return, Escape). The default is
#     "Up,Return", which chooses the menu's last item (Up from no selection wraps to the end).
#   -Action click: one left click.   -Action double: two left clicks inside the double-click time.
#
# It restores the cursor and never leaves a button or key down.
#
# This is injected input, not a hand: it is what an unattended session can do. A person clicking
# the icon exercises the same path from the shell onwards.
param(
  [Parameter(Mandatory = $true)][string]$Tooltip,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [ValidateSet("menu", "click", "double")][string]$Action = "menu",
  [string]$Keys = "Up,Return"
)
$virtualKeys = @{ Up = 0x26; Down = 0x28; Return = 0x0D; Escape = 0x1B }
$keyNames = $Keys.Split(",") | ForEach-Object { $_.Trim() }
foreach ($name in $keyNames) { if (-not $virtualKeys.ContainsKey($name)) { throw "-Keys: '$name' is not one of $($virtualKeys.Keys -join ', ')" } }
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class RC {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEKEYBD u; }
  [StructLayout(LayoutKind.Explicit)] public struct MOUSEKEYBD {
    [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static void Mouse(uint flags) {
    var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.dwFlags = flags; SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  public static string ClassAt(int x, int y) {
    POINT p; p.X = x; p.Y = y; var sb = new StringBuilder(128); GetClassNameW(WindowFromPoint(p), sb, 128); return sb.ToString();
  }
  public static void Move(int dx, int dy) {
    var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.dx = dx; i[0].u.mi.dy = dy; i[0].u.mi.dwFlags = 0x0001; SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Key(ushort vk) {
    var i = new INPUT[2]; i[0].type = 1; i[0].u.ki.wVk = vk; i[1].type = 1; i[1].u.ki.wVk = vk; i[1].u.ki.dwFlags = 2;
    SendInput(2, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static string Menus() {
    var sb2 = new StringBuilder();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(64); GetClassNameW(h, sb, 64); uint p; GetWindowThreadProcessId(h, out p);
      if (sb.ToString() == "#32768" && IsWindowVisible(h)) sb2.Append(p + " ");
      return true;
    }, IntPtr.Zero);
    return sb2.Length == 0 ? "none" : sb2.ToString();
  }
  // True while a popup menu window (class #32768) of the process is on screen.
  public static bool MenuOpen(uint pid) {
    bool found = false;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(64); GetClassNameW(h, sb, 64); uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && sb.ToString() == "#32768" && IsWindowVisible(h)) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$auto = [System.Windows.Automation.AutomationElement]
$tree = [System.Windows.Automation.TreeScope]
function Find-Icons($root) {
  $found = @()
  if (-not $root) { return $found }
  foreach ($e in $root.FindAll($tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try { if ($e.Current.Name -and $e.Current.Name.StartsWith($Tooltip)) { $found += $e } } catch {}
  }
  return $found
}
# The one icon with the tooltip. UI Automation does not say which process an icon belongs to, so
# two icons with the same tooltip cannot be told apart: an icon left behind by a process that was
# ended goes away when the pointer passes over it, so each is hovered once; if more than one is
# still there, another running app has the same tooltip, and the script clicks nothing.
function Find-Icon($root) {
  $found = @(Find-Icons $root)
  if ($found.Count -gt 1) {
    foreach ($e in $found) {
      $r = $e.Current.BoundingRectangle
      [RC]::SetCursorPos([int]($r.Left + $r.Width / 2) - 2, [int]($r.Top + $r.Height / 2)) | Out-Null
      foreach ($step in 1..2) { [RC]::Move(1, 0); Start-Sleep -Milliseconds 60 }
      Start-Sleep -Milliseconds 250
    }
    $found = @(Find-Icons $root)
  }
  if ($found.Count -gt 1) { throw "$($found.Count) notification icons have a tooltip starting with '$Tooltip'; another app with that tooltip is running, so nothing was clicked" }
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}
function Top-Window($class) {
  $auto::RootElement.FindFirst($tree::Children, (New-Object System.Windows.Automation.PropertyCondition($auto::ClassNameProperty, $class)))
}
function Click-At($rect, [uint32]$down, [uint32]$up) {
  $x = [int]($rect.Left + $rect.Width / 2); $y = [int]($rect.Top + $rect.Height / 2)
  [RC]::SetCursorPos($x - 3, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  # Real relative moves onto the point, so the element under the cursor sees the pointer arrive.
  foreach ($step in 1..3) { [RC]::Move(1, 0); Start-Sleep -Milliseconds 40 }
  Start-Sleep -Milliseconds 250
  [RC]::Mouse($down); Start-Sleep -Milliseconds 90
  [RC]::Mouse($up)
  "$x,$y"
}

$saved = New-Object RC+POINT
[RC]::GetCursorPos([ref]$saved) | Out-Null
try {
  $taskbar = Top-Window "Shell_TrayWnd"
  if (-not $taskbar) { throw "no taskbar (Shell_TrayWnd) in this session" }
  $icon = Find-Icon $taskbar
  $where = "the taskbar's notification area"
  if (-not $icon) {
    # In the overflow flyout: open it with a real click on its chevron, the notification area's first button.
    $chevron = $null
    foreach ($e in $taskbar.FindAll($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))) {
      try { if ($e.Current.AutomationId -eq "SystemTrayIcon" -and $e.Current.ClassName -eq "SystemTray.NormalButton") { $chevron = $e; break } } catch {}
    }
    if (-not $chevron) { throw "the icon is not on the taskbar and the overflow chevron was not found" }
    # The flyout may be open already (something else opened it, or an earlier run left it open):
    # the chevron toggles, so it is clicked only when the icon is not on show yet.
    $icon = Find-Icon (Top-Window "TopLevelWindowForOverflowXamlIsland")
    if ($icon -and $icon.Current.BoundingRectangle.Width -gt 0 -and -not $icon.Current.IsOffscreen) {
      "overflow flyout already open"
    } else {
      "overflow chevron: '$($chevron.Current.Name)', left click at $(Click-At $chevron.Current.BoundingRectangle 0x0002 0x0004)"
      Start-Sleep -Milliseconds 700
      $icon = Find-Icon (Top-Window "TopLevelWindowForOverflowXamlIsland")
    }
    $where = "the overflow flyout"
  }
  if (-not $icon) { throw "no notification icon whose tooltip starts with '$Tooltip'" }
  $r = $icon.Current.BoundingRectangle
  "icon found in ${where}: '$($icon.Current.Name)' ($($icon.Current.ControlType.ProgrammaticName), class $($icon.Current.ClassName), at $([int]$r.Left),$([int]$r.Top) size $([int]$r.Width)x$([int]$r.Height))"
  # Something else can sit over the flyout for a few seconds (a toast banner appears in the same
  # corner): wait until the window under the icon's centre is the shell's own.
  $cx = [int]($r.Left + $r.Width / 2); $cy = [int]($r.Top + $r.Height / 2)
  $shellClasses = @("TopLevelWindowForOverflowXamlIsland", "Shell_TrayWnd", "TrayNotifyWnd", "Windows.UI.Composition.DesktopWindowContentBridge", "Windows.UI.Input.InputSite.WindowClass")
  $under = [RC]::ClassAt($cx, $cy)
  for ($i = 0; $i -lt 60 -and $shellClasses -notcontains $under; $i++) { Start-Sleep -Milliseconds 500; $under = [RC]::ClassAt($cx, $cy) }
  "window under the icon's centre: $under"
  if ($shellClasses -notcontains $under) { throw "another window ($under) covers the icon" }
  if ($Action -eq "click") {
    "left click (SendInput) at $(Click-At $icon.Current.BoundingRectangle 0x0002 0x0004)"
    Start-Sleep -Milliseconds 300; [RC]::Key(0x1B)  # Escape closes the overflow flyout if it is still open
    return
  }
  if ($Action -eq "double") {
    "left click (SendInput) at $(Click-At $icon.Current.BoundingRectangle 0x0002 0x0004)"
    [RC]::Mouse(0x0002); Start-Sleep -Milliseconds 60; [RC]::Mouse(0x0004)
    "second left click at the same point, inside the double-click time"
    Start-Sleep -Milliseconds 300; [RC]::Key(0x1B)
    return
  }
  "right click (SendInput) at $(Click-At $icon.Current.BoundingRectangle 0x0008 0x0010)"
  $opened = $false
  for ($i = 0; $i -lt 60 -and -not $opened; $i++) { Start-Sleep -Milliseconds 50; $opened = [RC]::MenuOpen([uint32]$ProcessId) }
  if (-not $opened) { "popup menu windows on screen, by process: $([RC]::Menus())" }
  "the app's popup menu is on screen: $opened"
  if (-not $opened) { throw "the real click did not open the app's menu" }
  foreach ($name in $keyNames) { [RC]::Key([uint16]$virtualKeys[$name]); Start-Sleep -Milliseconds 150 }
  Start-Sleep -Milliseconds 300
  "$($keyNames -join ', ') pressed; the menu is on screen: $([RC]::MenuOpen([uint32]$ProcessId))"
} catch {
  # Close whatever this script opened (the overflow flyout, a menu) before reporting.
  [RC]::Key(0x1B)
  throw
} finally {
  [RC]::SetCursorPos($saved.X, $saved.Y) | Out-Null
}
