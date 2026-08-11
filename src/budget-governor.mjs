export class BudgetGovernor {
  constructor({ defaultParentBudget }) {
    this.defaultParentBudget = defaultParentBudget;
  }

  canStart({ task, alreadyUsed, alreadyReserved, parentBudget }) {
    const budget = parentBudget ?? this.defaultParentBudget;
    const required = task.tokenBudget ?? 0;
    return {
      allowed: alreadyUsed + alreadyReserved + required <= budget,
      budget,
      projected: alreadyUsed + alreadyReserved + required
    };
  }

  normalizeUsage(notification) {
    // App Server sends both a thread/session aggregate (`total`) and the
    // currently reported turn usage (`last`). Runtime task budgets must never
    // treat the aggregate as a new worker's consumption.
    return notification?.tokenUsage?.last?.totalTokens ?? notification?.tokenUsage?.total?.totalTokens ?? 0;
  }
}
