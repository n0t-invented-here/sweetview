# Proves the tray's single/double left-click handling inside the running demo
# (dev or compiled): posts the shell's tray callback messages to the tray's
# hidden message window, so the real timer and handlers run on the app's own
# loop, and reports the main window's visibility after each. No physical
# click, so it works while the icon sits in the overflow flyout.
#
#   pwsh -NoProfile -File scripts/tray-click-probe.ps1      (with the demo running)
#
# Expected: one click toggles after the double-click interval; a double click
# (UP, DBLCLK, UP) toggles exactly once.
$ErrorActionPreference = "Stop"
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class TC {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static IntPtr Main;
  public static IntPtr Tray;
  public static void Find(string title) {
    uint pid = 0;
    EnumWindows((h,l)=>{ var sb=new StringBuilder(256); GetWindowTextW(h,sb,256); if (sb.ToString()==title) { Main=h; GetWindowThreadProcessId(h, out pid); return false; } return true; }, IntPtr.Zero);
    if (pid == 0) throw new Exception("no window titled " + title);
    // sweetnative's tray lives on a NativeShellMessageWindow in the same process.
    EnumWindows((h,l)=>{ var sb=new StringBuilder(256); GetClassNameW(h,sb,256); uint p; GetWindowThreadProcessId(h, out p); if (p==pid && sb.ToString()=="NativeShellMessageWindow") { Tray=h; return false; } return true; }, IntPtr.Zero);
    if (Tray == IntPtr.Zero) throw new Exception("no tray message window in that process");
  }
}
"@
[TC]::Find("Web App")
$WM_TRAYICON = 0x8001  # WM_APP + 1, the callback message sweetnative registers; wParam is the tray's uid (1 for the first tray)
$UP = 0x0202; $DBL = 0x0203
$click = { param($m) [TC]::PostMessageW([TC]::Tray, $WM_TRAYICON, [IntPtr]1, [IntPtr]$m) | Out-Null }
"start: visible=$([TC]::IsWindowVisible([TC]::Main))"
& $click $UP
Start-Sleep -Milliseconds 300
"300ms after one left click: visible=$([TC]::IsWindowVisible([TC]::Main)) (still waiting for a second click)"
Start-Sleep -Milliseconds 1000
"1.3s after one left click: visible=$([TC]::IsWindowVisible([TC]::Main)) (single click fired)"
& $click $UP
Start-Sleep -Milliseconds 1300
"after another single click: visible=$([TC]::IsWindowVisible([TC]::Main))"
& $click $UP; Start-Sleep -Milliseconds 80; & $click $DBL; Start-Sleep -Milliseconds 80; & $click $UP
Start-Sleep -Milliseconds 1300
"after a double click: visible=$([TC]::IsWindowVisible([TC]::Main)) (toggled once, not twice)"
