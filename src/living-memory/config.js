function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

export const LIVING_MEMORY_DEFAULTS = Object.freeze({
  enabled: false,
  graduated: false,
  mode: 'shadow',               // shadow = collect/recall audit only; active = inject recall into the prompt
  // 远程 Embedding 往返通常已经接近数百毫秒；450ms 会让本地向量排序与序列化没有余量。
  // 超时后保留关键词检索结果，不影响回复主链路。
  recallTimeoutMs: 1800,
  maxInjectChars: 2400,
  maxRecallItems: 6,
  autoCapture: true,
  captureMinMessages: 6,
  captureIdleMs: 90000,
  allowPrivate: false,
  allowGlobal: false,
  groups: []
});

export function normalizeLivingMemoryConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // 早期试验版本把外部 HTTP 服务地址写进配置；内置版不再使用该字段，迁移时静默丢弃。
  const { serviceUrl: _legacyServiceUrl, ...current } = source;
  const groups = [...new Set((Array.isArray(raw?.groups) ? raw.groups : [])
    .map((id) => String(id || '').trim()).filter((id) => /^\d{1,15}$/.test(id)))].slice(0, 5000);
  return {
    ...LIVING_MEMORY_DEFAULTS,
    ...current,
    enabled: raw?.enabled === true,
    graduated: raw?.graduated === true,
    mode: raw?.mode === 'active' ? 'active' : 'shadow',
    recallTimeoutMs: clampInt(raw?.recallTimeoutMs, 300, 5000, LIVING_MEMORY_DEFAULTS.recallTimeoutMs),
    maxInjectChars: clampInt(raw?.maxInjectChars, 300, 8000, LIVING_MEMORY_DEFAULTS.maxInjectChars),
    maxRecallItems: clampInt(raw?.maxRecallItems, 1, 16, LIVING_MEMORY_DEFAULTS.maxRecallItems),
    autoCapture: raw?.autoCapture !== false,
    captureMinMessages: clampInt(raw?.captureMinMessages, 2, 60, LIVING_MEMORY_DEFAULTS.captureMinMessages),
    captureIdleMs: clampInt(raw?.captureIdleMs, 10_000, 30 * 60_000, LIVING_MEMORY_DEFAULTS.captureIdleMs),
    allowPrivate: raw?.allowPrivate === true,
    allowGlobal: raw?.allowGlobal === true,
    groups
  };
}

export function livingMemoryApplies(config, chatKey) {
  const cfg = normalizeLivingMemoryConfig(config);
  if (cfg.enabled !== true) return false;
  const text = String(chatKey || '');
  if (text.startsWith('private:') && !cfg.allowPrivate) return false;
  if (text.startsWith('group:') && cfg.groups.length) return cfg.groups.includes(text.slice('group:'.length));
  return text.startsWith('group:') || text.startsWith('private:');
}
