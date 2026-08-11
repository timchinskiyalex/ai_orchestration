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
  if ($LASTEXITCODE -ne 0) { throw "Could not read autonomous delivery status" }
  $raw
  Start-Sleep -Milliseconds $IntervalMs
}
