# Removes what this project's notifier tests left with the Windows notification platform: the
# toasts still queued or in the notification centre under a test's throwaway app id, and the
# platform's own per-app entry for that id. Only ids that start with one of the tests' prefixes
# are touched; `Sweetview.DesktopApp`, the default id of real applications, is never one of them.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File rust-rewrite/checks/clear-test-toasts.ps1 [-WhatIf]
#
# Run it with Windows PowerShell (powershell.exe), which can call the Windows Runtime directly.
param([switch]$WhatIf)
$ErrorActionPreference = "Stop"
$prefixes = @("Sweetview.NotifierTest.", "Sweetview.NotifierFallbackTest.", "Sweetview.NotifierHandles.", "Sweetview.Unused.")
$settings = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings"
$ids = @(Get-ChildItem $settings -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName } | Where-Object { $id = $_; @($prefixes | Where-Object { $id.StartsWith($_) }).Count -gt 0 })
"test app ids known to the notification platform: $($ids.Count)"
if ($WhatIf) { "(-WhatIf: nothing changed)"; return }
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$history = [Windows.UI.Notifications.ToastNotificationManager]::History
$cleared = 0; $removed = 0
foreach ($id in $ids) {
  try { $history.Clear($id); $cleared++ } catch { }
  $key = Join-Path $settings $id
  # The key is one this script just listed under the platform's settings, with a test prefix.
  if ((Split-Path $key -Leaf) -eq $id -and (Test-Path $key)) { Remove-Item -LiteralPath $key -Recurse -Force; $removed++ }
}
"toast history cleared for $cleared ids; platform entries removed: $removed"
