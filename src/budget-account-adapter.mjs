const ACCOUNT_SNAPSHOT_VERSION = 2;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const available = (value) => value !== undefined && value !== null;

function mergeAvailable(previous = {}, update = {}) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(update ?? {})) {
    if (!available(value)) continue;
    merged[key] = value && typeof value === "object" && !Array.isArray(value) ? mergeAvailable(previous[key], value) : value;
  }
  return merged;
}

function rawBuckets(response = {}) {
  if (response?.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object" && Object.keys(response.rateLimitsByLimitId).length > 0) return { ...response.rateLimitsByLimitId };
  if (response?.rateLimits && typeof response.rateLimits === "object") {
    const id = response.rateLimits.limitId ?? "default";
    return { [id]: response.rateLimits };
  }
  return {};
}

function normalizeWindows(buckets) {
  return Object.entries(buckets).flatMap(([key, bucket]) => ["primary", "secondary"].flatMap((kind) => {
    const window = bucket?.[kind];
    if (!window || !available(window.usedPercent)) return [];
    return [{ limitId: String(bucket.limitId ?? key), limitName: bucket.limitName ?? null, window: kind, usedPercent: number(window.usedPercent), windowDurationMins: number(window.windowDurationMins), resetsAt: window.resetsAt ?? null, planType: bucket.planType ?? null, source: "account/rateLimits/read" }];
  }));
}

export class BudgetAccountAdapter {
  constructor(store) { this.store = store; }

  async refresh(client) {
    const read = async (method) => {
      try { return await client.request(method, {}); }
      catch (error) { return { unavailable: true, error: error.message }; }
    };
    const [account, usage, rateLimits] = await Promise.all([read("account/read"), read("account/usage/read"), read("account/rateLimits/read")]);
    const snapshot = this.normalize({ account, usage, rateLimits, capturedAt: new Date().toISOString(), previous: this.store.latestAccountSnapshot() });
    this.store.recordAccountSnapshot(snapshot);
    return snapshot;
  }

  normalize({ account = {}, usage = {}, rateLimits = {}, capturedAt = new Date().toISOString(), previous = null }) {
    const accountData = account.account ?? {};
    const rateLimitBuckets = rawBuckets(rateLimits);
    return {
      schemaVersion: ACCOUNT_SNAPSHOT_VERSION,
      capturedAt,
      account: account.unavailable ? { availability: "unavailable" } : {
        availability: "available", type: accountData.type ?? null, email: accountData.email ?? null,
        planType: accountData.planType ?? null, requiresOpenaiAuth: Boolean(account.requiresOpenaiAuth)
      },
      accountActivity: (usage.dailyUsageBuckets ?? []).map((bucket) => ({ startDate: bucket.startDate, tokens: number(bucket.tokens), source: "account/usage/read" })),
      rateLimitBuckets,
      quotaWindows: normalizeWindows(rateLimitBuckets),
      diagnostics: [account, usage, rateLimits].filter((item) => item?.unavailable).map((item) => item.error)
    };
  }

  onRateLimitsUpdated(params) {
    const latest = this.store.latestAccountSnapshot();
    const existing = latest?.rateLimitBuckets ?? {};
    const update = params?.rateLimits ?? {};
    const updateId = update.limitId ?? (Object.keys(existing).length === 1 ? Object.keys(existing)[0] : "default");
    const mergedBuckets = { ...existing, [updateId]: mergeAvailable(existing[updateId], update) };
    const snapshot = {
      schemaVersion: ACCOUNT_SNAPSHOT_VERSION, capturedAt: new Date().toISOString(),
      account: latest?.account ?? { availability: "not-yet-read" }, accountActivity: latest?.accountActivity ?? [],
      rateLimitBuckets: mergedBuckets, quotaWindows: normalizeWindows(mergedBuckets), diagnostics: latest?.diagnostics ?? []
    };
    this.store.recordAccountSnapshot(snapshot);
    return snapshot;
  }

  forecast(tasks, history) {
    const ratiosByRole = new Map();
    for (const item of history) {
      if (!item.estimatedTokens || !item.tokenUsed) continue;
      const values = ratiosByRole.get(item.role) ?? [];
      values.push(item.tokenUsed / item.estimatedTokens);
      ratiosByRole.set(item.role, values);
    }
    const quantile = (values, q) => {
      if (!values?.length) return 1;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
    };
    let p50Tokens = 0;
    let p90Tokens = 0;
    for (const task of tasks) {
      const values = ratiosByRole.get(task.role);
      p50Tokens += Math.ceil(task.estimatedTokens * quantile(values, 0.5));
      p90Tokens += Math.ceil(task.estimatedTokens * quantile(values, 0.9));
    }
    return { schemaVersion: 1, method: "local task/run telemetry; not App Server quota or billing", sampleSize: history.length, taskCount: tasks.length, p50Tokens, p90Tokens };
  }
}
