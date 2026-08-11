param(
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

function Get-DeliveryStatus {
  $raw = & node src/index.mjs status --json 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Could not read delivery status" }
  return (($raw -join "`n") | ConvertFrom-Json)
}

function Invoke-Delivery([bool]$Initial, [bool]$ConfirmRemotePush) {
  $deliveryArgs = @('src/index.mjs', 'deliver')
  if ($Initial) {
    $deliveryArgs += @('--source', $source)
  } else {
    $deliveryArgs += '--resume'
  }
  if ($ConfirmRemotePush) { $deliveryArgs += '--confirm-remote-push' }
  & node @deliveryArgs
  if ($LASTEXITCODE -ne 0) { throw "Delivery command failed with exit code $LASTEXITCODE" }
}

function Require-Confirmation([string]$Expected, [string]$Message) {
  $answer = Read-Host "$Message Type $Expected to continue"
  if ($answer -cne $Expected) {
    Write-Host "Stopped by user. The delivery state is preserved; run this launcher again to resume."
    exit 0
  }
}

Write-Host "Live monitor opened in a separate PowerShell window."
Write-Host "Starting controlled delivery. This launcher will ask before every human gate."

$initial = $true
$confirmRemotePush = $false
while ($true) {
  Invoke-Delivery -Initial $initial -ConfirmRemotePush $confirmRemotePush
  $initial = $false
  $confirmRemotePush = $false
  $status = Get-DeliveryStatus
  $run = $status.deliveryRun

  if (-not $run) { throw "Delivery state was not found after execution" }
  Write-Host "Delivery state: $($run.state)"

  if ($run.state -eq 'completed_candidate_ready') {
    Write-Host "Delivery completed. Candidate branch is ready for review; main was not merged."
    exit 0
  }
  if ($run.state -in @('failed', 'conflict_blocked')) {
    throw "Delivery stopped in state '$($run.state)'. Read the live monitor and fix the reported blocker."
  }
  if ($run.state -eq 'awaiting_human_remote_handoff') {
    Require-Confirmation -Expected 'PUSH' -Message 'Candidate is locally verified. Allow push of swarm/candidate/* only?'
    $confirmRemotePush = $true
    continue
  }

  $gate = @($status.tasks | Where-Object { $_.status -in @('awaiting_human', 'awaiting_approval', 'blocked_budget') }) | Select-Object -First 1
  if (-not $gate) { throw "Delivery returned without a known terminal state or human gate" }

  Write-Host "Human gate: $($gate.id) | role=$($gate.role) | status=$($gate.status)"
  if ($gate.role -eq 'planner') {
    $forecast = $status.localForecast
    $budget = $status.localBudget
    Write-Host "Implementation forecast: P50=$($forecast.p50Tokens) tokens; P90=$($forecast.p90Tokens) tokens."
    Write-Host "Local rolling 7-day budget: used=$($budget.usedTokens); reserved=$($budget.reservedTokens); remaining=$($budget.remainingTokens) of $($budget.weeklyTokenLimit)."
    if ($forecast.p90Tokens -gt $budget.weeklyTokenLimit) {
      Require-Confirmation -Expected 'OVERRIDE' -Message 'P90 exceeds the local budget policy. Continue only with an explicit override?'
      $reason = Read-Host 'Enter a specific budget-override reason (at least 8 characters)'
      if ($reason.Length -lt 8) { throw 'Budget override reason is too short' }
      & node src/index.mjs override-budget --task $gate.id --reason $reason
      if ($LASTEXITCODE -ne 0) { throw 'Could not record budget override' }
    }
  }
  if ($gate.status -eq 'blocked_budget') {
    throw "Task is blocked by a budget limit. The launcher will not override it automatically; inspect the monitor and change policy deliberately if appropriate."
  }

  Require-Confirmation -Expected 'APPROVE' -Message "Review this gate in the monitor and approve task $($gate.id)?"
  & node src/index.mjs approve --task $gate.id
  if ($LASTEXITCODE -ne 0) { throw "Could not approve task $($gate.id)" }
}
