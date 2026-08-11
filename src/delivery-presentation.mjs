export function deliveryExitCode(delivery) {
  return (delivery?.state ?? delivery?.terminalState) === "completed_merged" ? 0 : 1;
}

export function deliveryFinalSummary(router, delivery) {
  const snapshot = router.statusSnapshot();
  const tasks = snapshot.tasks ?? [];
  const count = (status) => tasks.filter((task) => task.status === status).length;
  const publish = delivery.publish ?? snapshot.deliveryRun?.publish ?? {};
  return {
    terminalState: delivery.state ?? delivery.terminalState ?? "unknown",
    taskStages: { total: tasks.length, done: count("done"), failed: count("failed"), blocked: tasks.filter((task) => String(task.status).startsWith("blocked_")).length, interrupted: count("interrupted") },
    qa: snapshot.qualityReports?.map((item) => item.report?.verdict).filter(Boolean) ?? [], security: snapshot.securityReports?.map((item) => item.report?.verdict).filter(Boolean) ?? [], remediation: tasks.filter((task) => task.remediationRound > 0).length,
    tokens: snapshot.localBudget, candidate: publish.candidate ?? delivery.candidate ?? snapshot.deliveryRun?.candidate ?? null, pullRequest: publish.pullRequest ?? null, ci: publish.remoteCi ?? null, merge: publish.merge ?? null,
    artifacts: { integrationPath: delivery.integrationPath ?? snapshot.deliveryRun?.integrationPath ?? null, publicationCheckpoint: snapshot.deliveryRun?.publicationCheckpoint ?? null }, recoveryAction: publish.recovery?.action ?? delivery.recovery?.action ?? null
  };
}
