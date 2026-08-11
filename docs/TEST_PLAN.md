# План тестування каркасу

## 0. Версійна сумісність App Server

Перед контрольованим пілотом і після оновлення Codex CLI:

```powershell
npm test
npm run test:app-server-schema
```

## Quota-free full-flow regression

`npm test` includes fake-App-Server delivery coverage for concurrency/dependencies, mandatory Security and QA, structured QualityGate reports, bounded remediation/escalation, chained artifacts, remote allowlisting and idempotency, restart persistence, and lifecycle history beyond 100 in-memory entries. It never spends quota.

The delivery coordinator tests cover Bootstrap gate → approve → resume Planner → approve → resume workers/Security/QA/integration, plus confirmation-gated idempotent candidate publication. Security uses its own structured `SecurityGateReport`; Markdown is rejected.

Before explicit live E2E or remote handoff run:

```powershell
npm test
npm run test:app-server-schema
git diff --check
```

`npm test` includes a deterministic fake-App-Server full flow: Bootstrap → human gate → Planner → security/QA materialization → human gate → writer finalization → local integration. Run it successfully before the only quota-spending command:

```powershell
npm run e2e:live -- --confirm-spend-quota
```

Schema preflight створює тимчасову directory, генерує schema встановленого Codex CLI, перевіряє protocol/account methods і required fields та видаляє temporary files за будь-якого результату. Він не запускає App Server turn і не витрачає quota.

## 1. Unit-тести — вже є

```powershell
npm test
```

Покривається: state machine, budget reservation, витяг token usage та SQLite lifecycle. Ці тести не використовують Codex і не змінюють цільовий репозиторій.

## 2. Read-only App Server smoke

Ціль: один thread, один короткий turn, `sandbox: read-only`, без tool calls. Критерій: отримано `turn/completed` зі статусом `completed`; у SQLite записані `threadId`, `turnId`, event trace та token usage.

Якщо upstream stream тимчасово розривається, тест має завершитися як `failed` за `turnTimeoutMs`, а не зависнути. Повторювати не більше обмеженої кількості разів і зберігати причину у trace.

## 3. Worktree integration у disposable Git repository

Створити тимчасовий Git repo, зробити один commit і вказати його в `swarm.config.json`. Перевірити:

1. Coder-задача отримує окрему гілку `swarm/<task-id>`.
2. Початковий checkout не змінюється.
3. Друга writer-задача не використовує шлях першої.
4. Брудний target repository відхиляється до запуску App Server.

Цей тест не виконується над Taction, доки не буде погоджено конкретний репозиторій і base branch.

## 4. Approval simulation

Через fake App Server або contract test подати:

- `item/commandExecution/requestApproval`;
- `item/fileChange/requestApproval`;
- `item/permissions/requestApproval`.

Критерії: approval збережено, task переходить у `awaiting_approval`, default не схвалює дію, worker slot звільняється. Після появи UI додати ручне accept/decline із precise command/diff preview.

## 5. Вертикальний coding slice

Лише після кроків 1–4: одна маленька задача в тестовому репозиторії.

```text
Planner → людина затверджує план → Coder → QA → detached reviewer → людина merge-ить
```

Pass criteria:

- немає спільного writer-worktree;
- всі зміни мають task/thread/turn trace;
- budget не перевищено;
- тести мають реальний exit code;
- reviewer може зловити навмисно внесений дефект;
- жодних auto merge/push або неявних approvals.

## 6. Навантаження

Після успішних п’яти vertical slices підняти `maxConcurrentTasks` з 1 до 2 лише для незалежних worktree. Виміряти latency, token usage, rate-limit/stream errors, кількість approval і конфлікти. Не масштабувати кількість агентів, доки немає стабільних метрик.
