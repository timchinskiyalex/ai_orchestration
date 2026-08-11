# Архітектурний контракт MVP

## Межа відповідальності

```text
CLI / майбутній Slack або UI
          ↓
SwarmRouter
  ├─ SQLite: Task, Event, Approval
  ├─ BudgetGovernor
  ├─ WorktreeManager
  ├─ Role prompts
  └─ AppServerClient (stdio JSON-RPC)
          ↓
codex app-server
          ↓
Thread → Turn → Item/events → Approval requests
```

Router є єдиним control plane. Агент пропонує план або результат, але не отримує прямого права створювати process/thread, розширювати permissions, merge-ити гілку чи писати у shared state поза своїм task record.

## Базові гарантії template

| Вимога | Реалізація |
|---|---|
| Комунікація агентів | Router зберігає event trace й передає перевірений стислий контракт наступній ролі. Немає неконтрольованого chat-mesh. |
| Ізоляція контексту | thread + developer instructions + окремий `cwd`; для writer ролей — окремий Git worktree. |
| Дочірні агенти | `parentTaskId`, depth і child cap у state store. Створення відбувається тільки CLI/Router-ом. |
| Stopper | `maxConcurrentTasks`, `maxChildrenPerTask`, `maxDelegationDepth`, turn timeout і token budgets. |

## Autonomous delivery additions

Delivery lifecycle is persisted in SQLite append-only events and mirrored to `runtime/lifecycle.jsonl`; bounded in-memory telemetry is diagnostic-only. Writer worktrees finalize to artifacts, then mandatory Security and structured QA run before integration. Remediation writers use predecessor artifact heads and are bounded by `maxRemediationRounds`.

The persisted delivery coordinator resumes the same run: `deliver --source` → explicit `approve` → `deliver --resume`. A resume returns structured `awaiting_human` with the exact approve/resume command at every gate. Once all gates pass, resume integrates and may publish only when recorded `--confirm-remote-push` is present.

Integration creates only `swarm/candidate/*`. An allowlisted, idempotent remote adapter needs explicit confirmation; protected branches, force-push, auto-merge, and production actions do not exist. Candidate readiness requires local verification, QA/Security, confirmed push, and configured remote CI.
| API-ліміти | `thread/goal/set`, `thread/tokenUsage/updated`, reservation budget перед стартом і `blocked_budget`. |
| Інтернет | Не ввімкнено за замовчуванням. Він має з’явитися як окрема Research роль із allow-list і policy. |
| Людина у циклі | App Server approval → `awaiting_approval`; default — deny. Reviewer → `awaiting_human`. |
| Project Bootstrap | Документація імпортується контрольовано; Bootstrap працює read-only та формує blueprint для human review. |

## Дані й стани

`tasks` — єдине джерело поточного стану; `events` — append-only trace; `approvals` — аудит запитів дозволу. Markdown/ADR служать знаннями й поясненнями, але не чергою та не lock-механізмом.

```text
queued → preparing → running
                    ├→ awaiting_approval
                    ├→ awaiting_review → awaiting_human → done
                    ├→ blocked_budget
                    ├→ failed
                    └→ cancelled
```

## Інваріанти безпеки

1. Один coder-writer на один worktree.
2. Цільовий репозиторій має бути чистим до створення worktree.
3. Auto approval, push і merge відсутні.
4. Жодна задача не стартує, якщо її reservation виходить за parent budget.
5. Кожна подія прив’язана до `taskId`; кожен App Server run — до `threadId` і `turnId`.
6. Невідомий server request не схвалюється.

## Наступний розріз для реалізації

Після створення конкретної інсталяції треба додати graph executor:

```text
Bootstrap (docs → blueprint) → human approval → Planner (structured plan)
  → Router validates plan
  → Coder task(s), різні worktree
  → QA task
  → detached review/start
  → Human decision
```

Парсинг плану та створення дочірніх задач не вмикається, доки для нього не буде output schema, eval-кейсів і явних path/dependency validation rules.
