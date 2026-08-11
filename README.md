# AI Orchestration Template

## Live E2E report

Run the quota-spending smoke test only with explicit confirmation:

```powershell
npm run e2e:live -- --confirm-spend-quota
```

The launcher writes safe lifecycle metadata and a final summary under `runtime/e2e-runs/<run-id>/`, then updates `runtime/e2e-runs/latest.json`. Do not copy console output: ask Codex to inspect `runtime/e2e-runs/latest.json` instead. Reports never retain agent text, prompts, raw protocol payloads, command output, or secret values.

Універсальний, safety-first шаблон для побудови конкретних систем оркестрації над Codex App Server.

Він не містить документації, секретів, runtime state або правил конкретного продукту. Їх додає instance-репозиторій — наприклад, `ai_orchestration`.

```text
ai_orchestration_template     — reusable core і правила
          ↓ version/tag
ai_orchestration              — конкретна інсталяція, документи й runtime
```

## Що містить template

- Router і JSON-RPC `stdio` client до Codex App Server;
- SQLite state/event/approval store;
- ліміти concurrency, delegation depth, retries, budgets і turn timeout;
- worktree isolation для writer-ролей;
- базові ролі: Bootstrap, Planner, Coder, QA, Reviewer;
- документаційний intake та project bootstrap workflow;
- versioned `ProjectOverlay` із evidence ledger, path policies та declared verification commands;
- `ProjectOverlay` remains in the controller repository; workers receive only a sanitized execution snapshot in their prompt, never a copied Overlay file;
- controller-owned `WorkerArtifact` finalization і isolated integration branch/human merge handoff;
- окремі account quota snapshots, local rolling budget і local P50/P90 telemetry forecast;
- тестова основа, архітектурний контракт і план e2e-тестів.

## Що не входить

- конкретний код продукту, його вимоги чи secrets;
- auto-approval, auto-merge, auto-push і неконтрольований spawn;
- готовий Slack/UI bridge;
- облікові дані, модельні ліміти конкретної організації.

## Як створити інсталяцію

1. Створіть новий репозиторій із цього template або створіть локальну інсталяцію командою:

```powershell
npm run create-instance -- --target 'D:\Projects\my_orchestrator' --name 'My Orchestrator'
```

Instance repo має бути порожнім: дозволені лише його `.git` і стартовий `README.md`.

2. Скопіюйте `config/swarm.config.example.json` у `config/swarm.config.json`.
3. Вкажіть `project.name`, шлях до конкретного Git-репозиторію й `baseRef`.
4. Імпортуйте вихідну документацію:

```powershell
npm run ingest-docs -- --source 'D:\path\to\project-docs'
```

5. Поставте Bootstrap-задачу і запустіть Router:

```powershell
npm run enqueue -- --role bootstrap --title 'Project blueprint' --prompt 'Побудуй project blueprint за імпортованою документацією.'
npm run run
```

Bootstrap працює read-only і завершується в `awaiting_human`: людина затверджує scope/ADR/task graph перед запуском будь-якого Coder.

## Контрольований pilot workflow

Safe/manual mode є стандартним:

```text
Bootstrap → human approval → Planner → human approval → workers → integrate → human PR/merge
```

Перед approval Planner `status` показує окремо App Server quota windows, local actual usage, local reservation і local P50/P90 forecast. P90, що виходить за local rolling policy, не розблоковується звичайним approval:

```powershell
npm run override-budget -- --task '<planner-task-id>' --reason 'Pilot owner accepts the projected local budget exposure.'
npm run approve -- --task '<planner-task-id>'
```

Це є audit-recorded human override, а не зміна App Server quota. Router також не починає нові turns, якщо жива quota window досягає `quota.throttleAtUsedPercent`.

Для low-risk DAG після вже виконаних human gates можна використати:

```powershell
npm run run-to-integration
```

Команда ніколи не обходить pending human/approval gates; security, permission, schema та destructive changes залишаються на human gate.

`npm run orchestrate` також створює `docs/orchestration-generated/project-overlay.v1.json`. Він отримує факти про Git, stack, scripts, CI, scoped `AGENTS*.md` та sensitive path names без запуску repository scripts і без читання значень секретів.

Після того як усі writer-задачі мають finalized artifact, зберіть лише їхні task id в окремій candidate branch:

```powershell
npm run integrate -- --tasks '<task-id-1>,<task-id-2>'
```

Команда не merge-ить і не push-ить: вона створює `IntegrationManifest` із SHA-bound human merge gate.
`localVerification` у manifest — це лише локально виконані declared commands. `remoteCi` та `pullRequest` чесно позначаються `unavailable`, доки окремий adapter/credentials не буде підключено через `integration.remoteCiExtension` та `integration.pullRequestExtension`.

## Підтримка стеків

У цій версії production-ready verification підтриманий для Node-проєктів із `npm`, `pnpm` або `yarn`. Manager визначається спершу з `package.json#packageManager`, потім зі lockfile. Python, Go та .NET навмисно fail closed: для них потрібні окремі stack adapters, які зададуть discovery та allowlisted verification commands.

## Розвиток instance

Після human review Bootstrap blueprint стає основою для Planner → Coder → QA → Reviewer workflow. Instance фіксує версію template, з якої він створений, наприклад у `docs/orchestration-generated/template-version.json`; зміни template оновлюються свідомо, через diff та eval, а не автоматично.

## Перевірка

```powershell
npm test
npm run test:app-server-schema
```

`npm test` лишається portable і не вимагає локального Codex CLI. `npm run test:app-server-schema` окремо генерує schema встановленого CLI у тимчасову директорію, запускає лише protocol-contract test і гарантовано видаляє schema після перевірки. Виконуйте обидві команди перед контрольованим пілотом.

Реальний disposable App Server E2E навмисно не входить у звичайний запуск, бо витрачає account quota:

```powershell
npm run e2e:live -- --confirm-spend-quota
```

За потреби ручної інспекції schema:

```powershell
codex app-server generate-json-schema --out .\runtime\app-server-schema
```

Деталі каркасу: [architecture](docs/ARCHITECTURE.md) і [test plan](docs/TEST_PLAN.md).
