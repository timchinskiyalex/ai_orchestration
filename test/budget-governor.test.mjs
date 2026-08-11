import test from "node:test";
import assert from "node:assert/strict";
import { BudgetGovernor } from "../src/budget-governor.mjs";

test("budget governor reserves future task budget before start", () => {
  const governor = new BudgetGovernor({ defaultParentBudget: 60000 });
  const allowed = governor.canStart({ task: { tokenBudget: 20000 }, alreadyUsed: 10000, alreadyReserved: 20000 });
  assert.equal(allowed.allowed, true);
  const blocked = governor.canStart({ task: { tokenBudget: 20000 }, alreadyUsed: 30000, alreadyReserved: 20000 });
  assert.equal(blocked.allowed, false);
});

test("budget governor uses the App Server last-turn usage rather than aggregate thread usage", () => {
  const governor = new BudgetGovernor({ defaultParentBudget: 1 });
  assert.equal(governor.normalizeUsage({ tokenUsage: { last: { totalTokens: 1234 }, total: { totalTokens: 9_999_999 } } }), 1234);
  assert.equal(governor.normalizeUsage({ tokenUsage: { total: { totalTokens: 1234 } } }), 1234, "old fake/compat payloads remain supported");
});
