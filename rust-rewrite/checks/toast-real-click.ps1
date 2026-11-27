# Clicks the toast notification on screen with real mouse input (checklist items W5.3 and W5.5).
#
#   pwsh -NoProfile -File rust-rewrite/checks/toast-real-click.ps1 -Title "Menubar Notify" [-WaitSeconds 10]
#
# The banner is found where the shell shows it (the bottom right corner of the primary screen),
# and its text is read through UI Automation: it must hold the notification's title. The cursor
# is moved onto the banner's text and a left click is
# injected with SendInput, so the click travels through the shell as a person's does and comes
# back to the app as the toast's Activated event. The cursor is restored.
#
# This is injected input, not a hand: it is what an unattended session can do.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [int]$WaitSeconds = 10
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class TC {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  // The toast banner's window at a screen point, or zero.
  public static IntPtr BannerAt(int x, int y) {
    POINT p; p.X = x; p.Y = y; var h = WindowFromPoint(p); var t = new System.Text.StringBuilder(64); GetWindowTextW(h, t, 64);
    return t.ToString() == "New notification" ? h : IntPtr.Zero;
  }
  public static void Mouse(uint flags, int dx, int dy) {
    var i = new INPUT[1]; i[0].type = 0; i[0].mi.dx = dx; i[0].mi.dy = dy; i[0].mi.dwFlags = flags; SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

$auto = [System.Windows.Automation.AutomationElement]
$tree = [System.Windows.Automation.TreeScope]
Add-Type -AssemblyName System.Windows.Forms
# The banner's window is the shell's own and is not among the desktop's children in UI Automation,
# so it is found where it shows, in the bottom right corner of the primary screen's work area, by
# its window title, and its text is then read through UI Automation from that window's handle.
function Find-Toast {
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  foreach ($dy in 60, 100, 140, 180) {
    $h = [TC]::BannerAt($area.Right - 200, $area.Bottom - $dy)
    if ($h -eq [IntPtr]::Zero) { continue }
    try {
      $window = $auto::FromHandle($h)
      foreach ($e in $window.FindAll($tree::Descendants, (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))) {
        if ($e.Current.Name -eq $Title) { return @{ Window = $window; Text = $e } }
      }
    } catch {}
  }
  return $null
}

$saved = New-Object TC+POINT
[TC]::GetCursorPos([ref]$saved) | Out-Null
try {
  $found = $null
  for ($i = 0; $i -lt $WaitSeconds * 5 -and -not $found; $i++) { $found = Find-Toast; if (-not $found) { Start-Sleep -Milliseconds 200 } }
  if (-not $found) { throw "no toast banner with the title '$Title' appeared" }
  $r = $found.Text.Current.BoundingRectangle
  "toast banner found: window class $($found.Window.Current.ClassName), title text '$($found.Text.Current.Name)' at $([int]$r.Left),$([int]$r.Top)"
  # Let the banner finish sliding in, then read its place again.
  Start-Sleep -Milliseconds 700
  $r = $found.Text.Current.BoundingRectangle
  $x = [int]($r.Left + $r.Width / 2); $y = [int]($r.Top + $r.Height / 2)
  [TC]::SetCursorPos($x - 3, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  foreach ($step in 1..3) { [TC]::Mouse(0x0001, 1, 0); Start-Sleep -Milliseconds 40 }
  Start-Sleep -Milliseconds 250
  [TC]::Mouse(0x0002, 0, 0); Start-Sleep -Milliseconds 90; [TC]::Mouse(0x0004, 0, 0)
  "left click (SendInput) at $x,$y"
} finally {
  Start-Sleep -Milliseconds 300
  [TC]::SetCursorPos($saved.X, $saved.Y) | Out-Null
}
