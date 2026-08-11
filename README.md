# AI Orchestration Template

This is a reusable autonomous delivery runtime. A normal run has no approval, budget-override, push, PR, merge, or resume prompt:

```text
documentation → Bootstrap → Planner → DAG → parallel workers → WorkerArtifacts
→ Security → QA → bounded remediation → integration candidate → push → PR
→ remote CI → protected merge → completed_merged
```

## Start

From an instance repository, start the complete lifecycle with one command:

```powershell
./START_DEVELOPMENT.cmd
```

It opens a live monitor and exits only with a machine-readable terminal delivery state. The monitor includes task status, actual concurrency, token use, local budget/P50/P90, App Server quota windows, artifacts, candidate SHA, PR, CI checks, and merge SHA.

`npm run develop` runs the same launcher. `npm run deliver -- --source <requirements-dir>` is the non-interactive CLI equivalent. `npm run status -- --json` and `npm run watch` are read-only operational views.

## Default configuration

New instances use `autonomy.mode: "autonomous"`. The required config shape is:

```json
{
  "autonomy": {
    "mode": "autonomous",
    "autoApproveWorkflowGates": true,
    "autoRemediate": true,
    "autoPush": true,
    "autoCreatePullRequest": true,
    "autoMerge": true,
    "maxRemediationRounds": 3
  }
}
```

`manual` is retained only for emergency debugging. In manual mode the legacy `approve` and `override-budget` commands are available; they are not part of normal delivery.

P50/P90 is telemetry, never an approval gate. `estimatedTokens` is a forecast, while `tokenBudget` is a local scheduler reservation. Autonomous instances default `budget.enforceLocalLimits` to `true`: the rolling-week and run caps prevent a new reservation and the watchdog interrupts an active turn at its configured threshold. Set it to `false` only for an explicit diagnostic tracking-only run.

The generated App Server schema currently exposes `turn/interrupt` with `threadId` and `turnId`, but no server-side `turn/start` maximum-token parameter. Consequently an absolute zero-overshoot cap is unavailable upstream: the persisted budget interruption records the exact threshold and any observed threshold/cap overshoot caused by delayed usage reporting or interrupt latency. The watchdog uses `thread/tokenUsage/updated.tokenUsage.last.totalTokens` (never the aggregate `total`) and the configurable safety margin makes it fire early. Older aggregate-only audit rows remain visible but are excluded from new local budget reservations.

App Server quota is always a hard stop, reported as `blocked_quota`; the runtime never attempts to bypass account quota. Each active delivery has a PID/session heartbeat lease. SIGINT best-effort interrupts active turns and persists `interrupted`; a new launcher automatically recovers a stale lease as historical `interrupted` state rather than treating old tasks as live.

## GitHub automation

Remote automation uses authenticated local Git and GitHub CLI credentials; credentials are never stored in config or runtime state. It pushes only an exact verified `swarm/candidate/*` SHA, creates or finds the candidate-to-`main` PR idempotently, polls remote CI with a bounded timeout, and merges only after local integration, Security, QA, and required CI pass. It never force-pushes, writes worker branches to `main`, rewrites `main`, bypasses protection, or merges missing/failed CI.

Missing or invalid GitHub credentials ends as `blocked_credentials`. Required CI failure/timed-out checks end as `blocked_ci`. A branch-protection refusal ends as `blocked_branch_protection`. These states retain the candidate, structured remote action data, and recovery instruction.

## Greenfield products

The controller root is not a product root. Configure allowlisted product roots:

```json
"productRoots": [
  { "id": "frontend", "path": "frontend", "adapter": "next-node" },
  { "id": "backend", "path": "backend", "adapter": "dotnet" }
]
```

Greenfield repositories are valid before either root exists. Planner must create `scaffold-product`; every product task directly depends on it. After scaffold, the controller refreshes the ProjectOverlay from the scaffold worktree. Frontend verification runs only declared scripts in `frontend/package.json`; backend verification runs allowlisted `dotnet test` against the discovered solution/project in `backend/`. A scaffolded component without a declared/allowlisted verification command blocks integration rather than passing empty QA.

## Verification

```powershell
npm test
npm run test:app-server-schema
git diff --check
```

The regular test suite is deterministic and quota-free. The real App Server E2E remains opt-in and is never run by the launcher.
