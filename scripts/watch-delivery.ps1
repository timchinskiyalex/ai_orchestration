param(
  [ValidateRange(250, 60000)]
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:NODE_NO_WARNINGS = '1'

while ($true) {
  Clear-Host
  $raw = & node src/index.mjs status --json 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Warning "Status read failed; monitor will retry. Delivery is not stopped by this monitor." }
  else { $raw }
  Start-Sleep -Milliseconds $IntervalMs
}
