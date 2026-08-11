import test from "node:test";
import assert from "node:assert/strict";
import { BudgetAccountAdapter } from "../src/budget-account-adapter.mjs";

test("account adapter maps real App Server account, usage and multi-limit schema shapes", async () => {
  const snapshots = [];
  const adapter = new BudgetAccountAdapter({ recordAccountSnapshot: (value) => snapshots.push(value), latestAccountSnapshot: () => snapshots.at(-1) });
  const client = { request: async (method) => ({
    "account/read": { account: { type: "chatgpt", email: "pilot@example.com", planType: "pro" }, requiresOpenaiAuth: true },
    "account/usage/read": { summary: {}, dailyUsageBuckets: [{ startDate: "2026-08-10", tokens: 123 }] },
    "account/rateLimits/read": { rateLimits: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2 } }, rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2 } }, premium: { limitId: "premium", limitName: "Premium", primary: { usedPercent: 20 } } } }
  })[method] };
  const snapshot = await adapter.refresh(client);
  assert.deepEqual(snapshot.account, { availability: "available", type: "chatgpt", email: "pilot@example.com", planType: "pro", requiresOpenaiAuth: true });
  assert.deepEqual(snapshot.accountActivity[0], { startDate: "2026-08-10", tokens: 123, source: "account/usage/read" });
  assert.equal(snapshot.quotaWindows.length, 3);
  assert.equal(snapshot.quotaWindows.find((item) => item.window === "secondary").windowDurationMins, 10080);
});

test("sparse account/rateLimits/updated merges available values without erasing snapshot", () => {
  const snapshots = [];
  const store = { recordAccountSnapshot: (value) => snapshots.push(value), latestAccountSnapshot: () => snapshots.at(-1) };
  const adapter = new BudgetAccountAdapter(store);
  store.recordAccountSnapshot(adapter.normalize({ account: { account: { type: "chatgpt", email: "pilot@example.com", planType: "pro" }, requiresOpenaiAuth: true }, usage: { summary: {}, dailyUsageBuckets: [{ startDate: "2026-08-10", tokens: 1 }] }, rateLimits: { rateLimits: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 2 } } } }));
  const merged = adapter.onRateLimitsUpdated({ rateLimits: { limitId: "codex", primary: { usedPercent: 80 } } });
  assert.equal(merged.account.email, "pilot@example.com");
  assert.equal(merged.accountActivity[0].tokens, 1);
  assert.equal(merged.quotaWindows.find((item) => item.window === "primary").usedPercent, 80);
  assert.equal(merged.quotaWindows.find((item) => item.window === "secondary").resetsAt, 2);
});

test("non-empty rateLimitsByLimitId has priority over fallback rateLimits", () => {
  const adapter = new BudgetAccountAdapter({});
  const snapshot = adapter.normalize({ rateLimits: { rateLimits: { limitId: "fallback", primary: { usedPercent: 10 } }, rateLimitsByLimitId: { preferred: { limitId: "preferred", primary: { usedPercent: 60 } } } } });
  assert.deepEqual(snapshot.quotaWindows.map((item) => item.limitId), ["preferred"]);
});

test("empty rateLimitsByLimitId falls back to populated rateLimits", () => {
  const adapter = new BudgetAccountAdapter({});
  const snapshot = adapter.normalize({ rateLimits: { rateLimits: { limitId: "fallback", primary: { usedPercent: 30 } }, rateLimitsByLimitId: {} } });
  assert.equal(snapshot.quotaWindows[0].limitId, "fallback");
  assert.equal(snapshot.quotaWindows[0].usedPercent, 30);
});

test("rateLimits alone produces quotaWindows", () => {
  const adapter = new BudgetAccountAdapter({});
  const snapshot = adapter.normalize({ rateLimits: { rateLimits: { limitId: "only", primary: { usedPercent: 45 } } } });
  assert.equal(snapshot.quotaWindows[0].limitId, "only");
  assert.equal(snapshot.quotaWindows[0].window, "primary");
});

test("local forecast is not quota", () => {
  const adapter = new BudgetAccountAdapter({});
  const forecast = adapter.forecast([{ role: "backend", estimatedTokens: 100 }], [{ role: "backend", estimatedTokens: 100, tokenUsed: 150 }]);
  assert.equal(forecast.p50Tokens, 150);
  assert.match(forecast.method, /not App Server quota/);
});
