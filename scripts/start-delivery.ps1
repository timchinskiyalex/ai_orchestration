param(
  [switch]$ConfirmRemotePush,
  [ValidateRange(250, 60000)]
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'docs\project-specifications'
$watchScript = Join-Path $PSScriptRoot 'watch-delivery.ps1'

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "Project documentation directory is missing: $source"
}

$dirty = & git -C $projectRoot status --porcelain
if ($LASTEXITCODE -ne 0) {
  throw "Cannot inspect Git status for $projectRoot"
}
if ($dirty) {
  throw "Refusing to start: commit or stash the working-tree changes first.`n$dirty"
}

Start-Process -FilePath 'powershell.exe' -WorkingDirectory $projectRoot -ArgumentList @(
  '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchScript,
  '-IntervalMs', $IntervalMs
)

Write-Host "Live monitor opened in a separate PowerShell window."
Write-Host "Starting Bootstrap. The run will pause at required human approval gates."

$deliveryArgs = @('run', 'deliver', '--', '--source', $source)
if ($ConfirmRemotePush) { $deliveryArgs += '--confirm-remote-push' }
& npm.cmd @deliveryArgs
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) { exit $exitCode }

Write-Host "Delivery is paused at a gate or has completed. Review: npm run status"
Write-Host "To continue after approval: npm run deliver -- --resume"
