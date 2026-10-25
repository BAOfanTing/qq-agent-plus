// 控制台指标：只收集低基数计数（总请求数/状态码分桶/延迟分位），不按路由/群/用户打标签。
// 内存里滚动保留最近 1000 次请求的延迟，快照时排序算 p50/p95。
export function createMetrics({ maxSamples = 1000 } = {}) {
  const startedAt = Date.now();
  const durations = [];
  const byStatus = {};
  let total = 0;

  function recordHttp(status, durationMs) {
    total += 1;
    const bucket = `${Math.floor((Number(status) || 0) / 100)}xx`;
    byStatus[bucket] = (byStatus[bucket] || 0) + 1;
    const ms = Number(durationMs);
    if (Number.isFinite(ms)) {
      durations.push(ms);
      if (durations.length > maxSamples) durations.shift();
    }
  }

  function snapshot() {
    const sorted = [...durations].sort((a, b) => a - b);
    const percentile = (ratio) => (sorted.length
      ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] * 10) / 10
      : 0);
    return {
      startedAt,
      requests: { total, byStatus: { ...byStatus } },
      latencyMs: { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) }
    };
  }

  return { recordHttp, snapshot };
}
