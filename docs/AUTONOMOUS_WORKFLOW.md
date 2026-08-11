# Autonomous workflow

Normal operation is one command: `./START_DEVELOPMENT.cmd`.

The runtime imports source Markdown, generates an evidence-backed ProjectOverlay, runs Bootstrap and Planner, materializes the validated DAG, schedules independent work up to `router.maxConcurrentTasks`, finalizes writer commits, performs Security and QA, performs bounded remediation, integrates passing artifacts, pushes a candidate branch, creates/fetches a PR, waits for remote CI, and merges only after all required checks are green.

The autonomous terminal states are `completed_merged`, `failed`, `blocked_budget`, `blocked_quota`, `blocked_credentials`, `blocked_ci`, `blocked_branch_protection`, and `conflict_blocked`. The state store keeps task/artifact/report/remote-action records so restart is idempotent at push, PR, CI, and merge stages.

`autonomy.mode: "manual"` is an emergency debugging mode. It deliberately restores manual gates; it is not the default deployment mode.
