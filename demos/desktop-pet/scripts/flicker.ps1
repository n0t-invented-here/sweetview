# Flicker detector: captures the pet window many times in a row and reports
# how much each frame differs from the previous one. Animation changes a few
# percent of the pixels between frames; a dropped or blank frame (a repaint of
# the browser, say) shows up as a spike that comes and goes.
#
#   pwsh -NoProfile -File scripts/flicker.ps1 [-Title Pet] [-Frames 40] [-IntervalMs 25]
param(
    [string] $Title = "Pet",
    [int] $Frames = 40,
    [int] $IntervalMs = 25
)
$ErrorActionPreference = "Stop"

Add-Type -ReferencedAssemblies System.Drawing, System.Drawing.Common, System.Collections, System.Drawing.Primitives @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class F {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr Find(string t){ IntPtr f=IntPtr.Zero; EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; var sb=new StringBuilder(256); GetWindowTextW(h,sb,256); if(sb.ToString()==t){f=h;return false;} return true;},IntPtr.Zero); return f; }
  // Fraction of pixels whose colour differs noticeably between two same-sized bitmaps.
  public static double Diff(System.Drawing.Bitmap a, System.Drawing.Bitmap b) {
    var ra = a.LockBits(new System.Drawing.Rectangle(0,0,a.Width,a.Height), System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    var rb = b.LockBits(new System.Drawing.Rectangle(0,0,b.Width,b.Height), System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    int n = a.Width * a.Height; var pa = new byte[n*4]; var pb = new byte[n*4];
    Marshal.Copy(ra.Scan0, pa, 0, n*4); Marshal.Copy(rb.Scan0, pb, 0, n*4);
    a.UnlockBits(ra); b.UnlockBits(rb);
    int changed = 0;
    for (int i = 0; i < n*4; i += 4) {
      int d = Math.Abs(pa[i]-pb[i]) + Math.Abs(pa[i+1]-pb[i+1]) + Math.Abs(pa[i+2]-pb[i+2]);
      if (d > 48) changed++;
    }
    return (double)changed / n;
  }
}
"@

$h = [F]::Find($Title)
if ($h -eq [IntPtr]::Zero) { throw "no visible window titled '$Title'" }
$r = New-Object F+RECT; [void][F]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hgt = $r.B - $r.T

$shots = @()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt $Frames; $i++) {
  [void][F]::GetWindowRect($h, [ref]$r)   # the pet walks; follow it
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $g.Dispose()
  $shots += $bmp
  Start-Sleep -Milliseconds $IntervalMs
}
$elapsed = $sw.ElapsedMilliseconds

$diffs = @()
for ($i = 1; $i -lt $shots.Count; $i++) { $diffs += [F]::Diff($shots[($i - 1)], $shots[$i]) }
$sorted = $diffs | Sort-Object
$median = $sorted[[int]($sorted.Count / 2)]
$max = ($diffs | Measure-Object -Maximum).Maximum
$spikes = ($diffs | Where-Object { $_ -gt [Math]::Max(0.15, 4 * $median) }).Count
"{0} frames in {1} ms; frame-to-frame change: median {2:P1}, max {3:P1}, spikes {4}" -f @($shots.Count, $elapsed, $median, $max, $spikes)
"per frame: " + (($diffs | ForEach-Object { "{0:N0}" -f ($_ * 100) }) -join " ")
