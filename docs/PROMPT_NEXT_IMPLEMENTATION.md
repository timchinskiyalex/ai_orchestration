# Prompt: довести orchestration template до готовності для реальних проєктів

Працюй у репозиторії `ai_orchestration_template`. Не створюй нову архітектуру поруч і не переписуй наявний Router без потреби. Продовж поточний Node/ESM template, який уже має Codex App Server client, SQLite state, DAG, спеціалізовані workers (`backend`, `frontend`, `database`, `qa`, `security`, `devops`), policy packs, Git worktrees і CLI.

## Мета

Зробити template готовим для контрольованого запуску реальних engineering-проєктів:

```text
документація + Git repository
→ ProjectOverlay
→ Bootstrap / Planner / Router
→ спеціалізовані workers у worktrees
→ finalized WorkerArtifact
→ integration branch
→ незалежна verification / CI gate
→ PR або human merge gate
```

Реалізуй лише шість компонентів нижче. Не додавай Dashboard, multi-candidate worker ranking, automatic production deployment, automatic production writes, semantic conflict-resolution agent або full event sourcing.

## 1. BudgetAccountAdapter

Додай окремий adapter для Codex App Server account API:

- `account/read`;
- `account/usage/read`;
- `account/rateLimits/read`;
- `account/rateLimits/updated` notification;
- наявний `thread/tokenUsage/updated` для task/run usage.

Суворо розділяй:

- **account activity**: історія token activity / daily buckets;
- **quota windows**: `limitId`, `limitName`, `usedPercent`, `windowDurationMins`, `resetsAt`;
- **local task/run budget**: ліміти та фактичні токени Router;
- **P50/P90 forecast**: лише локальний прогноз, побудований з історії task/run telemetry. Це не account quota і не billing truth.

У CLI `status` покажи ці блоки окремо. Не пиши “% тижневого ліміту”, якщо upstream реально не надав саме такого window. Для локального guardrail використовуй явну назву на кшталт `local rolling 7-day budget`.

Перед запуском implementation tasks Router має показати P50/P90 forecast, local reservation та quota windows. Якщо P90 перевищує локальний policy limit — не запускай без явного human approval.

## 2. ProjectOverlayGenerator

Реалізуй deterministic-first генератор `ProjectOverlay` для конкретного Git repository.

V1 обов’язково має витягувати з provenance/confidence:

- Git root, base SHA, branch, clean/dirty status;
- Node/TypeScript stack: `package.json`, lockfile, `tsconfig*`, workspace structure;
- declared scripts: install, format, lint, typecheck, unit/integration/E2E tests, build;
- GitHub Actions workflow metadata, jobs, commands, permissions, environments; `required_checks` позначай `unknown`, якщо їх не можна довести з репозиторію;
- `AGENTS.md` / `AGENTS.override.md` зі scope, без flatten у один prompt;
- modules/areas: backend, frontend, database/migrations, infrastructure;
- path policies: `deny_write`, `approval_required`, `generated_do_not_edit`, `context_exclude`;
- sensitive path metadata (`.env*`, `*.pem`, `*.key`, `credentials*`, `secrets*`) без читання або збереження значень;
- evidence ledger: path, selector/line range, parser, value, confidence.

Не запускай repository-owned scripts автоматично лише для discovery. Не вгадуй команди, framework, CI checks або generated paths. Використовуй confidence: `verified`, `declared`, `documented`, `inferred`, `unknown`.

Overlay має бути версіонованим JSON, зберігатися як artifact і передаватися Planner, Router, workers та Integrator як джерело фактів про repository.

## 3. WorktreeFinalizer + WorkerArtifact

Після завершення writer worker-а запускай deterministic `WorktreeFinalizer`.

Він повинен:

1. перевірити worktree і base SHA;
2. перевірити diff проти дозволених шляхів TaskEnvelope та path policies Overlay;
3. зафіксувати changed paths і SHA-256 diff;
4. виконати лише дозволені verification commands із Overlay;
5. створити контрольований Git commit від імені runtime/controller, а не LLM worker-а;
6. переконатися, що `git status --porcelain` порожній;
7. створити версіонований `WorkerArtifact`.

`WorkerArtifact` щонайменше містить:

```text
task id, work-unit id, worker id,
base SHA, branch, head SHA, tree SHA,
commit range, diff checksum, changed paths,
verification results, policy result,
overlay/version references, finalized-by metadata.
```

Integrator не має приймати raw worktree path або агентський текст замість finalized artifact.

## 4. Integrator MVP

Інтегратор приймає тільки валідні `WorkerArtifact`.

Він повинен:

- створити окрему integration branch/worktree, ніколи не збирати зміни напряму в `main`;
- перевірити base/head SHA, ancestry, commit range, diff hash, changed paths, clean worktree і verification artifact;
- застосовувати artifacts у dependency order з детермінованим tie-break;
- блокувати semantic, security, migration та infrastructure conflicts як `CONFLICT_BLOCKED`;
- запускати локальну verification лише за командами ProjectOverlay;
- формувати `IntegrationManifest`;
- створювати PR або human merge gate; merge має бути явною, SHA-bound дією;
- зберігати rollback metadata.

MVP може не робити remote GitHub CI/merge автоматично: спочатку реалізуй локальну integration branch і підготовлений handoff. Не виконуй production actions.

## 5. Real Codex App Server E2E

Додай disposable E2E fixture repository без зовнішніх залежностей, наприклад маленький Python `unittest` bugfix repo з базовим Git commit та `AGENTS.md`.

E2E повинен реально перевіряти:

```text
Overlay → Planner/Router → real codex app-server stdio JSONL
→ isolated worktree → worker edit → Finalizer → WorkerArtifact
→ Integrator → independent test command.
```

Не довіряй self-report agent-а. Harness незалежно перевіряє test exit code, Git diff, changed paths, clean finalized worktree, artifact SHA і candidate integration branch.

Також додай lightweight protocol-contract test для `initialize → initialized → thread/start → turn/start → notifications → turn/completed`, використовуючи schema, згенеровану встановленим Codex CLI.

E2E не має торкатися реальних репозиторіїв, production credentials, мережі чи файлів поза disposable temp root.

## 6. Planner / Router evals

Додай machine-readable fixtures і deterministic graders. Мінімальні hard regression cases:

- auth/authz зміна → `backend` + mandatory `security` gate;
- schema/destructive database операція → `database`, risk flags, human approval where required;
- CI/deployment permissions → `devops` + `security`;
- frontend/backend contract boundary → коректна декомпозиція та залежності;
- adversarial user text не може вимкнути security gate або підвищити permissions;
- ambiguous request не має спричиняти вигаданих змін.

Перевіряй структуровані інваріанти кодом, а не LLM judge: домен, risk flags, gates, permissions, dependencies, worker eligibility. Кожен реальний routing incident має ставати regression fixture.

## Загальні вимоги

- Збережи SQLite state tables + append-only events; не переходь на full event sourcing.
- Додай версії для всіх нових persisted contracts.
- Кожна зміна state + event має бути транзакційною.
- Не передавай secrets у prompts, events або artifacts.
- Не розширюй permissions за рішенням LLM.
- Не дозволяй worker-у merge/push у target branch.
- Використовуй `apply_patch` для редагування файлів.
- Додай unit/integration тести на кожен новий контракт і workflow.
- Перед завершенням запусти всі доступні тести, syntax checks і `git diff --check`.

## Definition of Done

Робота завершена лише коли:

1. CLI показує окремо account quota windows, account activity, local usage/budget і P50/P90 forecast.
2. Overlay містить evidence-backed repository facts без запуску arbitrary scripts.
3. Кожен writer worker завершується clean committed `WorkerArtifact`.
4. Integrator створює та перевіряє integration branch тільки з finalized artifacts.
5. Disposable реальний App Server E2E проходить незалежну перевірку Git і тестів.
6. Evals блокують небезпечні routing regressions.
7. Існуючі сценарії template не зламані; усі тести проходять.
