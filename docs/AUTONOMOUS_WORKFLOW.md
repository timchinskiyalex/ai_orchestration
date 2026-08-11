# Autonomous orchestration workflow

This template has a safe/manual default and an optional low-risk run-to-integration path. It is deliberately not a collection of manually queued agent prompts.

```powershell
npm run orchestrate -- --source 'D:\path\to\project-docs'
npm run status
```

`orchestrate` imports the Markdown documentation, creates the Bootstrap task, starts Codex App Server, and runs the Bootstrap Architect. The task finishes at one required human gate. Inspect the result file shown by `npm run status`, then approve it:

```powershell
npm run approve -- --task '<bootstrap-task-id>'
```

Approval automatically runs Planner. Planner must return a validated JSON DAG with a primary engineering domain, supporting domains, concrete risk flags, dependencies, acceptance checks, and a token estimate for every work unit.

Planner then stops at a second gate. `npm run status` displays App Server quota separately from local actual usage, reservation, P50/P90 forecast and local rolling budget. If P90 is above the local policy, record a separate human override with a reason before approval; ordinary approval is not an override.

```powershell
npm run approve -- --task '<planner-task-id>'
```

For a safe DAG after all human gates are already satisfied, `npm run run-to-integration` runs workers and creates only a local candidate integration branch. It refuses if any human or tool approval remains pending. No remote CI, PR, merge or push is implied by this command.

The Router maps each work unit to a `backend`, `frontend`, `database`, `qa`, `security`, or `devops` worker. It adds security review for sensitive risk flags and QA verification only when Planner requested it. Up to `router.maxConcurrentTasks` independent tasks run in parallel (10 in the example configuration). Writer work happens in isolated worktrees; verifier/reviewer tasks reuse the primary worker's worktree read-only.

Reviewer tasks remain at a final human gate. This MVP does not auto-merge or auto-push branches. That boundary prevents an unreviewed project plan from changing the target branch.

The structured contracts are in `src/workflow-contract.mjs`; domain rules are in `policies/`. Invalid Bootstrap or Planner JSON fails closed; the Router does not guess a task graph.
