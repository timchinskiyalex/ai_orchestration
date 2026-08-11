param(
  [ValidateRange(250, 60000)]
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

Write-Host "Live delivery monitor. Press Ctrl+C in this window to stop monitoring; delivery continues."
& npm.cmd run watch -- --interval-ms $IntervalMs
exit $LASTEXITCODE
