# Autonomous workflow

Normal operation is one command: `./START_DEVELOPMENT.cmd`.

The runtime imports source Markdown, generates an evidence-backed ProjectOverlay, runs Bootstrap and Planner, materializes the validated DAG, schedules independent work up to `router.maxConcurrentTasks`, finalizes writer commits, performs Security and QA, performs bounded remediation, integrates passing artifacts, pushes a candidate branch, creates/fetches a PR, waits for remote CI, and merges only after all required checks are green.

The autonomous terminal states are `completed_merged`, `failed`, `interrupted`, `blocked_budget`, `blocked_quota`, `blocked_credentials`, `blocked_ci`, `blocked_branch_protection`, and `conflict_blocked`. The state store keeps task/artifact/report/remote-action records so restart is idempotent at push, PR, CI, and merge stages. A PID/session lease and heartbeat make abandoned `running` tasks recoverable: launcher startup marks a missing/dead/stale owner as `interrupted` and preserves its thread, turn, token usage, and recovery reason.

The App Server protocol has no server-side maximum-token field on `turn/start`. Runtime enforcement therefore uses per-role `interruptThresholdTokens` plus a safety margin and `turn/interrupt(threadId, turnId)`. It records actual usage and observed overshoot; it never claims that delayed reporting is a zero-overshoot hard cap.

`autonomy.mode: "manual"` is an emergency debugging mode. It deliberately restores manual gates; it is not the default deployment mode.
