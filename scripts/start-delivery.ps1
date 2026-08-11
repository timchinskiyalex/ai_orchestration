param(
  [ValidateRange(250, 60000)]
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'docs\project-specifications'
$watchScript = Join-Path $PSScriptRoot 'watch-delivery.ps1'

if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Project documentation directory is missing: $source" }

$dirty = & git -C $projectRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Git status for $projectRoot" }
$controllerOwnedPrefixes = @('docs/orchestration-input/', 'docs/orchestration-generated/', 'runtime/')
$blockingDirty = @($dirty | Where-Object {
  $path = if ($_.Length -gt 3) { $_.Substring(3).Replace('\', '/') } else { $_ }
  -not ($controllerOwnedPrefixes | Where-Object { $path -eq $_.TrimEnd('/') -or $path.StartsWith($_) })
})
if ($blockingDirty) { throw "Refusing to start: commit or stash code/product working-tree changes first.`n$($blockingDirty -join "`n")" }

Start-Process -FilePath 'powershell.exe' -WorkingDirectory $projectRoot -ArgumentList @(
  '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchScript, '-IntervalMs', $IntervalMs
)

function Get-DeliveryStatus {
  # Windows PowerShell can promote Node's harmless experimental SQLite warning
  # to NativeCommandError when the launcher uses ErrorActionPreference=Stop.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & node src/index.mjs status --json 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) { throw "Could not read delivery status" }
  return (($raw -join "`n") | ConvertFrom-Json)
}

$status = Get-DeliveryStatus
$terminal = @('completed_merged', 'failed', 'blocked_budget', 'blocked_quota', 'blocked_credentials', 'blocked_ci', 'blocked_branch_protection', 'conflict_blocked')
$resume = $status.deliveryRun -and -not ($terminal -contains $status.deliveryRun.state)
$deliveryArgs = @('src/index.mjs', 'deliver')
if ($resume) { $deliveryArgs += '--resume' } else { $deliveryArgs += @('--source', $source) }

Write-Host "Live monitor opened in a separate PowerShell window. Starting autonomous delivery."
& node @deliveryArgs
if ($LASTEXITCODE -ne 0) { throw "Delivery command failed with exit code $LASTEXITCODE" }

$final = Get-DeliveryStatus
if (-not $final.deliveryRun) { throw "Delivery state was not found after execution" }
Write-Host "Delivery state: $($final.deliveryRun.state)"
if ($final.deliveryRun.state -notin $terminal) { throw "Delivery ended without a machine-readable terminal state: $($final.deliveryRun.state)" }
if ($final.deliveryRun.state -ne 'completed_merged') { exit 1 }
