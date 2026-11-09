# Screenshot of the pet window (found by its title) and its surroundings, for
# checking the rendering without a display in front of you.
#
#   pwsh -NoProfile -File scripts/shot.ps1 -Title Pet -Out build/pet.png [-Margin 40]
#
# Prints the window rectangle and the alpha-bearing rows/columns are left to
# the caller; this only captures what is on screen.
param(
    [string] $Title = "Pet",
    [Parameter(Mandatory)] [string] $Out,
    [int] $Margin = 40,
    [double] $WaitSeconds = 0
)
$ErrorActionPreference = "Stop"
if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

Add-Type -ReferencedAssemblies System.Drawing, System.Collections, System.Drawing.Primitives @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> Find(string title) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      if (sb.ToString() == title) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$windows = [Win]::Find($Title)
if ($windows.Count -eq 0) { throw "no visible window titled '$Title'" }
$rect = New-Object Win+RECT
[void][Win]::GetWindowRect($windows[0], [ref]$rect)
Write-Host ("window {0},{1} {2}x{3}" -f $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))

$left = $rect.Left - $Margin
$top = $rect.Top - $Margin
$width = ($rect.Right - $rect.Left) + 2 * $Margin
$height = ($rect.Bottom - $rect.Top) + 2 * $Margin
$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($left, $top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save((Resolve-Path (Split-Path $Out) | Join-Path -ChildPath (Split-Path $Out -Leaf)), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "wrote $Out"
