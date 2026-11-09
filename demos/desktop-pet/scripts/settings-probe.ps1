# Drives the settings window with real input: drags the pet aside, clicks the
# "Click through" switch twice, and after each click reports the settings
# file and whether the pet window's transparent corners take clicks.
#
#   pwsh -NoProfile -File scripts/settings-probe.ps1   (with PET_SETTINGS=1 so the window is open)
#
# The switch is found by its position in the page (Mantine layout, 460 px
# wide window): adjust $SwitchX/$SwitchY if the page changes.
param(
    [int] $SwitchX = 46,
    [int] $SwitchY = 402
)
$ErrorActionPreference = "Stop"

Add-Type -ReferencedAssemblies System.Collections @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class T {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  public static IntPtr Find(string t){ IntPtr f=IntPtr.Zero; EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; var sb=new StringBuilder(256); GetWindowTextW(h,sb,256); if(sb.ToString()==t){f=h;return false;} return true;},IntPtr.Zero); return f; }
  public static bool IsPet(int x,int y, IntPtr pet){ var p=new POINT{X=x,Y=y}; return GetAncestor(WindowFromPoint(p),2)==pet; }
}
"@
$MOVE = 0x0001; $DOWN = 0x0002; $UP = 0x0004

function Click($x, $y) {
  [void][T]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 150
  [T]::mouse_event($DOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  [T]::mouse_event($UP, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 500
}

$pet = [T]::Find("Pet")
if ($pet -eq [IntPtr]::Zero) { throw "no visible window titled 'Pet'" }
$settings = [T]::Find("Pet Settings")
if ($settings -eq [IntPtr]::Zero) { throw "no visible window titled 'Pet Settings' (run with PET_SETTINGS=1)" }
$r = New-Object T+RECT
$s = New-Object T+RECT

# Drag the pet well to the left so it does not cover the settings window.
[void][T]::GetWindowRect($pet, [ref]$r)
$cx = [int](($r.L + $r.R) / 2); $cy = [int](($r.T + $r.B) / 2)
[void][T]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 150
[T]::mouse_event($DOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
for ($i = 1; $i -le 30; $i++) { [void][T]::SetCursorPos($cx - $i * 20, $cy); [T]::mouse_event($MOVE, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 12 }
[T]::mouse_event($UP, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 900
[void][T]::GetWindowRect($pet, [ref]$r)
"pet at $($r.L),$($r.T) size $($r.R - $r.L)"

function Corners($label) {
  [void][T]::GetWindowRect($pet, [ref]$r)
  [void][T]::SetCursorPos($r.L + 8, $r.T + 8); Start-Sleep -Milliseconds 150
  $tl = [T]::IsPet($r.L + 8, $r.T + 8, $pet)
  [void][T]::SetCursorPos($r.R - 8, $r.T + 8); Start-Sleep -Milliseconds 150
  $tr = [T]::IsPet($r.R - 8, $r.T + 8, $pet)
  $mx = [int](($r.L + $r.R) / 2); $my = [int](($r.T + $r.B) / 2) + 20
  [void][T]::SetCursorPos($mx, $my); Start-Sleep -Milliseconds 150
  $c = [T]::IsPet($mx, $my, $pet)
  "{0}: top-left pet={1}  top-right pet={2}  body pet={3}" -f $label, $tl, $tr, $c
}
$file = Join-Path $env:APPDATA "sweetview-pet/settings.json"

Corners "before"
[void][T]::GetWindowRect($settings, [ref]$s)
"settings window at $($s.L),$($s.T); clicking the switch at +$SwitchX,+$SwitchY"
Click ($s.L + $SwitchX) ($s.T + $SwitchY)
"file: " + ((Get-Content $file -Raw) -replace "\s+", " ")
Corners "after 1st click"
Click ($s.L + $SwitchX) ($s.T + $SwitchY)
"file: " + ((Get-Content $file -Raw) -replace "\s+", " ")
Corners "after 2nd click"
