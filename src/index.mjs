import { existsSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { ingestDocumentation } from "./project-intake.mjs";
import { scaffoldInstance } from "./instance-scaffold.mjs";
import { readLatestE2eReport } from "./e2e-report.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = process.env.SWARM_CONFIG ?? join(root, "config", "swarm.config.json");
const [command, ...args] = process.argv.slice(2);

function option(name, required = true) {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) throw new Error(`Missing ${name}`);
    return null;
  }
  return args[index + 1];
}
const hasFlag = (name) => args.includes(name);

function usage() {
  console.log(`Usage:
  node src/index.mjs init
  node src/index.mjs status
  node src/index.mjs recover
  node src/index.mjs ingest-docs --source <directory-with-project-docs>
  node src/index.mjs orchestrate --source <directory-with-project-docs>
  node src/index.mjs approve --task <task-id>
  node src/index.mjs override-budget --task <planner-task-id> --reason <human-reason>
  node src/index.mjs integrate --tasks <finalized-task-id,finalized-task-id>
  node src/index.mjs run-to-integration
  node src/index.mjs deliver --source <directory-with-project-docs>
  node src/index.mjs deliver --resume
  node src/index.mjs watch [--once] [--interval-ms <ms>]
  node src/index.mjs create-instance --target <empty-instance-repository> --name <project-name>
  node src/index.mjs enqueue --role <bootstrap|planner|backend|frontend|database|qa|security|devops> --title <text> --prompt <text> [--parent <taskId>]
  node src/index.mjs run`);
}

try {
  if (command === "init" && !existsSync(configPath)) {
    copyFileSync(join(root, "config", "swarm.config.example.json"), configPath);
    console.log(`Created ${configPath}. Edit repository and baseRef, then run init again.`);
    process.exit(0);
  }
  if (command === "create-instance") {
    const result = scaffoldInstance({
      templateRoot: root,
      target: option("--target"),
      projectName: option("--name"),
    });
    console.log(`Created instance '${result.projectName}' in ${result.target}`);
    process.exit(0);
  }
  const { SwarmRouter } = await import("./router.mjs");
  const router = new SwarmRouter(loadConfig(configPath));
  try {
    if (command === "init") console.log(router.init());
    else if (command === "recover") {
      const recovered = router.recoverStaleDeliveries();
      console.log(JSON.stringify({ recovered: recovered.map((run) => ({ id: run.id, state: run.state, recovery: run.recovery })) }, null, 2));
    }
    else if (command === "status") {
      if (hasFlag("--json")) {
        console.log(JSON.stringify(router.statusSnapshot(), null, 2));
      } else {
      console.table(router.list().map((task) => ({ id: task.id, role: task.role, status: task.status, title: task.title, used: task.tokenUsed, estimate: task.estimatedTokens, cap: task.tokenBudget })));
      const readiness = router.executionReadiness();
      const budget = readiness.localBudget;
      console.table([{ scope: budget.label, localActualUsed: budget.usedTokens, localReserved: budget.reservedTokens, localRemaining: budget.remainingTokens, localUsedPercent: budget.usedPercent, localPolicyLimit: budget.weeklyTokenLimit }]);
      console.table([{ ...readiness.localForecast, localP90ProjectedTokens: readiness.localP90ProjectedTokens, localP90ProjectedPercent: readiness.localP90ProjectedPercent }]);
      const account = router.accountSummary();
      console.table([{ account: account.account?.availability, capturedAt: account.capturedAt ?? null, diagnostics: (account.diagnostics ?? []).join(" | ") }]);
      console.table(account.accountActivity ?? []);
      console.table(account.quotaWindows ?? []);
      console.table([readiness.quotaThrottle]);
      const latestE2e = readLatestE2eReport(join(root, "runtime", "e2e-runs"));
      console.table([latestE2e ? {
        status: latestE2e.status, startedAt: latestE2e.startedAt, finishedAt: latestE2e.finishedAt, durationMs: latestE2e.durationMs,
        stage: latestE2e.stage, taskId: latestE2e.task?.id ?? null, resultPath: latestE2e.resultPath ?? null
      } : { status: "no E2E report", startedAt: null, finishedAt: null, durationMs: null, stage: null, taskId: null, resultPath: null }]);
      }
    } else if (command === "watch") {
      const intervalMs = Number(option("--interval-ms", false) ?? 1_000);
      if (!Number.isInteger(intervalMs) || intervalMs < 250) throw new Error("--interval-ms must be an integer of at least 250");
      const render = () => {
        const snapshot = router.statusSnapshot();
        console.log(JSON.stringify({ generatedAt: snapshot.generatedAt, deliveryRun: snapshot.deliveryRun, tasks: snapshot.tasks.map((task) => ({ id: task.id, title: task.title, role: task.role, status: task.status, dependencies: task.dependencies, blocker: task.blocker, tokenUsed: task.tokenUsed, remediationRound: task.remediationRound })), activeTurns: snapshot.activeTurns, realConcurrency: snapshot.realConcurrency, localBudget: snapshot.localBudget, localForecast: snapshot.localForecast, appServerQuotaWindows: snapshot.appServerQuotaWindows, securityReports: snapshot.securityReports, qualityReports: snapshot.qualityReports, remoteProgress: snapshot.deliveryRun?.publish ?? null }, null, 2));
      };
      render();
      if (!hasFlag("--once")) await new Promise((resolve) => { const timer = setInterval(render, intervalMs); process.on("SIGINT", () => { clearInterval(timer); resolve(); }); });
    } else if (command === "deliver") {
      const { DeliveryCoordinator } = await import("./delivery-coordinator.mjs");
      const coordinator = new DeliveryCoordinator(router);
      router.on("lifecycle", (event) => {
        const stage = {
          "thread started": "task started",
          "turn started": "turn started",
          "turn completed": "turn completed",
          "token usage updated": "usage update",
          "budget interrupt requested": "budget interrupt",
          "budget preflight blocked": "budget blocked",
          "stale delivery recovered": "stale run recovered",
          "app-server exited": "App Server exited",
          "controller shutdown requested": "shutdown interrupt"
        }[event.type];
        if (stage) console.log(`[progress] ${stage}${event.taskId ? ` task=${event.taskId}` : ""}${event.threadId ? ` thread=${event.threadId}` : ""}${event.turnId ? ` turn=${event.turnId}` : ""}${event.tokenUsage ? ` usage=${JSON.stringify(event.tokenUsage)}` : ""}${event.actualTokens !== undefined ? ` usage=${event.actualTokens}/${event.threshold}` : ""}`);
      });
      const delivery = hasFlag("--resume")
        ? await coordinator.resume()
        : await coordinator.begin({ source: option("--source") });
      console.log(JSON.stringify(delivery, null, 2));
    }
    else if (command === "ingest-docs") {
      const result = ingestDocumentation({ source: option("--source"), repository: router.config.repository, destinationRelative: router.config.project.documentationDir });
      console.log(`Imported ${result.files} Markdown files into ${result.destination}`);
      console.log(`Inventory: ${result.inventoryPath}`);
    } else if (command === "orchestrate") {
      const result = ingestDocumentation({ source: option("--source"), repository: router.config.repository, destinationRelative: router.config.project.documentationDir });
      const overlay = await router.ensureProjectOverlay();
      const bootstrap = router.startProject();
      console.log(`Imported ${result.files} Markdown files. ProjectOverlay: ${overlay.path}. Bootstrap task: ${bootstrap.id}`);
      console.table([router.budgetSummary()]);
      await router.runUntilIdle();
      console.log("Bootstrap completed. In autonomous mode the delivery command continues directly through Planner, DAG, verification, and publication.");
    } else if (command === "approve") {
      const result = router.approveHumanGate(option("--task"));
      if (result.readiness) {
        console.table([result.readiness.localBudget, result.readiness.localForecast]);
        console.table(result.readiness.accountQuota.quotaWindows ?? []);
      }
      if (result.shouldRun) console.log(JSON.stringify({ approvedTaskId: option("--task"), next: result.next?.id ?? null, resumeCommand: "npm run deliver -- --resume" }, null, 2));
      else console.log("Approved.");
    } else if (command === "override-budget") {
      const result = router.overrideBudgetGate(option("--task"), option("--reason"));
      console.log(`Recorded explicit budget override for ${result.task.id}. Approve the Planner separately to start workers.`);
      console.table([result.readiness.localBudget, result.readiness.localForecast]);
    } else if (command === "enqueue") {
      const task = router.enqueue({ role: option("--role"), title: option("--title"), prompt: option("--prompt"), parentTaskId: option("--parent", false) });
      console.log(`Queued ${task.id} (${task.role}): ${task.title}`);
    } else if (command === "integrate") {
      const result = await router.integrateFinalized(option("--tasks").split(",").map((value) => value.trim()).filter(Boolean));
      console.log(`Integration manifest: ${result.path}`);
      console.table([{ status: result.manifest.status, candidateBranch: result.manifest.branch, candidateSha: result.manifest.headSha, localVerification: result.manifest.localVerification?.status ?? "unknown", remoteCi: result.manifest.remoteCi?.status ?? "unavailable", pr: result.manifest.pullRequest?.status ?? "unavailable", nextAction: result.manifest.humanMergeGate?.action }]);
    } else if (command === "run-to-integration") {
      const result = await router.runToIntegration();
      for (const artifact of result.writerArtifacts) console.log(`WorkerArtifact: ${artifact.taskId} → ${artifact.headSha}`);
      console.log(`IntegrationManifest: ${result.integration.path}`);
      console.log(`Candidate branch: ${result.integration.manifest.branch ?? "none"}`);
      console.log(`Local verification: ${result.integration.manifest.localVerification?.status ?? "not-run"}`);
      console.log(`Next action: ${result.nextAction}`);
    } else if (command === "run") {
      await router.runUntilIdle();
      console.log("Router is idle. Run `npm run status` to inspect tasks.");
    } else usage();
  } finally { router.close(); }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
