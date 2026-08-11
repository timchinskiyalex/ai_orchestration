param(
  [ValidateRange(250, 60000)]
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

while ($true) {
  Clear-Host
  & node src/index.mjs status --json
  if ($LASTEXITCODE -ne 0) { throw "Could not read autonomous delivery status" }
  Start-Sleep -Milliseconds $IntervalMs
}
