# Exercises the pet window with real input: moves the cursor over solid and
# transparent spots and reports which window the OS would deliver a click to,
# then drags the pet with the mouse and reports where the window ended up.
#
#   pwsh -NoProfile -File scripts/probe.ps1 [-Title Pet]
param([string] $Title = "Pet")
$ErrorActionPreference = "Stop"

Add-Type -ReferencedAssemblies System.Collections @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class P {
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
  public static string At(int x,int y){ var p=new POINT{X=x,Y=y}; var h=GetAncestor(WindowFromPoint(p),2); var sb=new StringBuilder(256); GetWindowTextW(h,sb,256); return h.ToString()+" '"+sb+"'"; }
}
"@
$MOVE = 0x0001; $DOWN = 0x0002; $UP = 0x0004

$h = [P]::Find($Title)
if ($h -eq [IntPtr]::Zero) { throw "no visible window titled '$Title'" }
$r = New-Object P+RECT; [void][P]::GetWindowRect($h, [ref]$r)
"pet hwnd $h  rect $($r.L),$($r.T) - $($r.R),$($r.B)"

function Probe($name, $x, $y) {
  [void][P]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 150
  "{0,-12} ({1},{2}) -> {3}" -f $name, $x, $y, [P]::At($x, $y)
}
$cx = [int](($r.L + $r.R) / 2); $cy = [int](($r.T + $r.B) / 2)
Probe "centre" $cx $cy
Probe "lower body" $cx ($r.B - 40)
Probe "top-left" ($r.L + 6) ($r.T + 6)
Probe "top-right" ($r.R - 6) ($r.T + 6)
Probe "centre" $cx $cy

# Drag: press on the centre, move 220 px right in steps, release.
[void][P]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 150
[P]::mouse_event($DOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
for ($i = 1; $i -le 22; $i++) { [void][P]::SetCursorPos($cx + $i * 10, $cy - 60); [P]::mouse_event($MOVE, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 16 }
Start-Sleep -Milliseconds 120
$mid = New-Object P+RECT; [void][P]::GetWindowRect($h, [ref]$mid)
"while held: window at $($mid.L),$($mid.T)"
[P]::mouse_event($UP, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 900
$after = New-Object P+RECT; [void][P]::GetWindowRect($h, [ref]$after)
"after drop : window at $($after.L),$($after.T)  (moved {0} px right, back on the ground: {1})" -f ($after.L - $r.L), ($after.B -eq $r.B)
