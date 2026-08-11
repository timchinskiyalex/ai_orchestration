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
    return notification?.tokenUsage?.total?.totalTokens ?? 0;
  }
}
