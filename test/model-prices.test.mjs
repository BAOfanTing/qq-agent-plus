import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-model-prices-'));
process.env.QQ_AGENT_DATA_DIR = root;

const prices = await import('../src/pricing/model-prices.js');
const feed = await import('../src/pricing/price-feed.js');

after(() => {
  prices.setRemotePrices({});   // 还原全局状态，别影响其他用例
  fs.rmSync(root, { recursive: true, force: true });
});

const OFFICIAL = { api: { useOfficialPrice: true } };
const priceOf = (id, cfg = OFFICIAL, options = undefined) => prices.resolveModelPrice(id, cfg, null, options);

test('渠道的点号版本名走别名表（真实案例：deepseek/deepseek-v4.1-flash）', () => {
  const p = priceOf('deepseek/deepseek-v4.1-flash');
  assert.equal(p.source, 'official');
  assert.equal(p.matched, 'deepseek-flash');
  assert.equal(p.confidence, 'alias');
  assert.match(p.via, /deepseek-v4\.1-flash → deepseek-flash/);
  assert.equal(p.in, 1);
  assert.equal(p.out, 4);
  assert.equal(p.cached, 0.02);
  assert.equal(p.unpriced, false);
  // 别名不改峰谷等其它字段：DeepSeek Flash 是分时段计价的
  assert.ok(p.peak && p.peak.in === 2 && p.peak.out === 8, '别名解析出的价格要保留峰谷档');
});

test('精确命中优先于归一化与别名', () => {
  const p = priceOf('deepseek-v4-flash-0731');
  assert.equal(p.matched, 'deepseek-v4-flash-0731');
  assert.equal(p.confidence, 'exact');
});

test('去掉叫法后缀与日期快照后缀', () => {
  const preview = priceOf('kimi-k3-preview');
  assert.equal(preview.matched, 'kimi-k3');
  assert.equal(preview.confidence, 'normalized');

  const free = priceOf('glm-5.3-flash:free');
  assert.equal(free.matched, 'glm-5.3-flash');
  assert.equal(free.confidence, 'normalized');

  const dated = priceOf('deepseek-v4-flash-20260101');
  assert.equal(dated.matched, 'deepseek-v4-flash');
  assert.equal(dated.confidence, 'normalized');
});

test('渠道前缀会被剥掉；前缀匹配取最长条目', () => {
  assert.equal(priceOf('openai/gpt-5.6-luna').matched, 'gpt-5.6-luna');
  const insider = priceOf('z-ai/glm-5.3-insider');
  assert.equal(insider.matched, 'glm-5.3', '不能被更短的 glm-5 抢先命中');
  assert.equal(insider.confidence, 'prefix');
});

test('点号归并只作为近似兜底（带 fuzzy 标记）', () => {
  const dashed = priceOf('deepseek.v4-flash');
  assert.equal(dashed.matched, 'deepseek-v4-flash');
  assert.equal(dashed.confidence, 'fuzzy');

  const candidates = prices.modelIdCandidates('deepseek-v4.1-flash');
  assert.ok(
    candidates.some((c) => c.id === 'deepseek-v4-flash' && c.confidence === 'fuzzy' && c.via === '点号版本归并'),
    '点号版本归并要出现在候选里且标记为 fuzzy'
  );
  assert.equal(candidates[0].id, 'deepseek-v4.1-flash', '原样候选排第一');
});

test('查不到的模型是"未定价"，不是"免费"', () => {
  const unknown = priceOf('totally-unknown-model-9');
  assert.equal(unknown.source, 'unmatched');
  assert.equal(unknown.unpriced, true);
  assert.equal(unknown.in, 0);
  assert.equal(unknown.matched, null);

  // 官方价开关关掉、没自定义价、也没填兜底单价 → 同样是未定价
  const bare = priceOf('another-unknown-model', { api: {} });
  assert.equal(bare.source, 'unmatched');
  assert.equal(bare.unpriced, true);

  // 官方免费（单价 0）≠ 未定价：这是"真的不要钱"
  const freeModel = priceOf('glm-4.7-flash');
  assert.equal(freeModel.unpriced, false);
  assert.equal(freeModel.in, 0);
  assert.equal(freeModel.out, 0);
});

test('渠道价优先于官方表，且不会串到别的渠道', () => {
  const cfg = {
    api: {
      useOfficialPrice: true,
      modelPrices: {
        'commandcode：deepseek/deepseek-v4.1-flash': { in: 0.5, out: 2, cached: 0.05 }
      }
    }
  };
  const byChannel = priceOf('deepseek/deepseek-v4.1-flash', cfg, { vendor: 'commandcode' });
  assert.equal(byChannel.source, 'channel');
  assert.equal(byChannel.kind, 'actual', '用户自己填的价属于实付口径');
  assert.equal(byChannel.in, 0.5);
  assert.equal(byChannel.unpriced, false);

  // 同一个模型走别的渠道：渠道价不生效，回落到官方表（估算口径）
  const otherChannel = priceOf('deepseek/deepseek-v4.1-flash', cfg, { vendor: '别的站' });
  assert.equal(otherChannel.source, 'official');
  assert.equal(otherChannel.kind, 'estimate');
  assert.equal(otherChannel.matched, 'deepseek-flash');

  // 不带渠道信息时也拿不到渠道价
  assert.equal(priceOf('deepseek/deepseek-v4.1-flash', cfg).source, 'official');
});

test('自定义价（不分渠道）在官方表之前生效，且对任何渠道都生效', () => {
  const cfg = {
    api: {
      useOfficialPrice: true,
      modelPrices: { 'deepseek-flash': { in: 3, out: 12 } }
    }
  };
  const noChannel = priceOf('deepseek-flash', cfg);
  assert.equal(noChannel.source, 'custom');
  assert.equal(noChannel.kind, 'actual');
  assert.equal(noChannel.in, 3);

  const withChannel = priceOf('deepseek-flash', cfg, { vendor: '随便哪个站' });
  assert.equal(withChannel.source, 'custom', '没有渠道价时，模型自定义价仍然生效');
  assert.equal(withChannel.in, 3);
});

test('关掉官方价格表时才用全局兜底单价（老语义保留）', () => {
  const cfg = { api: { useOfficialPrice: false, priceInputPerM: 9, priceOutputPerM: 18 } };
  const p = priceOf('deepseek-flash', cfg);
  assert.equal(p.source, 'manual');
  assert.equal(p.kind, 'estimate');
  assert.equal(p.in, 9);

  // 官方价开着的配置里，兜底单价不该偷偷生效（否则"未定价"会被藏起来）
  const withOfficial = priceOf('完全没听过的模型', { api: { useOfficialPrice: true, priceInputPerM: 9, priceOutputPerM: 18 } });
  assert.equal(withOfficial.source, 'unmatched');
  assert.equal(withOfficial.unpriced, true);
});

test('远程价格表的条目来源标成 remote（口径仍是估算）', () => {
  prices.setRemotePrices({ 'acme-flash-x': { in: 5, out: 20 } });
  try {
    const p = priceOf('acme-flash-x');
    assert.equal(p.source, 'remote');
    assert.equal(p.kind, 'estimate');
    assert.equal(p.in, 5);
  } finally {
    prices.setRemotePrices({});
  }
});

test('priceKind 把三种口径分开', () => {
  assert.equal(prices.priceKind({ kind: 'actual' }), 'actual');
  assert.equal(prices.priceKind({ kind: 'estimate' }), 'estimate');
  assert.equal(prices.priceKind({ unpriced: true }), 'unpriced');
  assert.equal(prices.priceKind(null), 'unpriced');
});

test('包月/订阅条目：不按 token 计价，作为固定支出（实付口径）', () => {
  const cfg = {
    api: {
      useOfficialPrice: true,
      modelPrices: { 'cmd：deepseek/deepseek-v4.1-flash': { billing: 'flat', amount: 68, period: 'month' } }
    }
  };
  const p = priceOf('deepseek/deepseek-v4.1-flash', cfg, { vendor: 'cmd' });
  assert.equal(p.billing, 'flat');
  assert.equal(p.amount, 68);
  assert.equal(p.period, 'month');
  assert.equal(p.in, 0, '包月条目不该给出 token 单价');
  assert.equal(p.out, 0);
  assert.equal(p.unpriced, false, '包月是"已定价"，不是未定价');
  assert.equal(p.kind, 'actual', '用户自己声明的计费方式属于实付口径');
  assert.equal(p.source, 'channel');
});

test('本地/自建条目：只统计 token，不计费', () => {
  const cfg = { api: { useOfficialPrice: true, modelPrices: { 'local-qwen': { billing: 'none' } } } };
  const p = priceOf('local-qwen', cfg);
  assert.equal(p.billing, 'none');
  assert.equal(p.in, 0);
  assert.equal(p.out, 0);
  assert.equal(p.unpriced, false);
  assert.equal(p.kind, 'actual');

  // 如果只写了 billing 而没有单价，仍然算"已定价"（不会掉进未定价）
  const bare = priceOf('whatever-local', { api: { useOfficialPrice: true, modelPrices: { 'whatever-local': { billing: 'none' } } } });
  assert.equal(bare.unpriced, false);
});

test('billingOf 归一化：大小写/周期/金额', () => {
  assert.deepEqual(prices.billingOf({ billing: 'FLAT', amount: '30', period: 'DAY' }), { billing: 'flat', amount: 30, period: 'day' });
  assert.deepEqual(prices.billingOf({ billing: 'none', amount: 99 }), { billing: 'none', amount: 0, period: 'month' });
  assert.deepEqual(prices.billingOf({}), { billing: 'token', amount: 0, period: 'month' });
  assert.deepEqual(prices.billingOf({ billing: 'flat', amount: -5 }), { billing: 'flat', amount: 0, period: 'month' });
});

test('远程/渠道价目表也能带计费方式', () => {
  const norm = feed.normalizePriceFeed({
    prices: {
      'sub-model': { billing: 'flat', amount: 20, period: 'month', in: 0, out: 0 },
      'local-model': { billing: 'none', in: 0, out: 0 },
      'plain-model': { in: 1, out: 4 }
    }
  });
  assert.ok(norm);
  assert.equal(norm.prices['sub-model'].billing, 'flat');
  assert.equal(norm.prices['sub-model'].amount, 20);
  assert.equal(norm.prices['sub-model'].period, 'month');
  assert.equal(norm.prices['local-model'].billing, 'none');
  assert.equal(norm.prices['plain-model'].billing, undefined, '没写 billing 的条目不硬塞字段');
});

/* ── 账户级口径：设置页只需选一次，不用逐模型配 ── */

const CURRENT = 'deepseek/deepseek-v4.1-flash';

test('账户口径：渠道倍率（官方价 × 折扣）', () => {
  const cfg = { api: { model: CURRENT, useOfficialPrice: true, costMode: 'multiplier', costMultiplier: 0.5 } };
  const p = priceOf(CURRENT, cfg, { vendor: 'cmd' });
  assert.equal(p.source, 'multiplier');
  assert.equal(p.kind, 'actual', '倍率是用户自己声明的渠道价 → 实付口径');
  assert.equal(p.in, 0.5);
  assert.equal(p.out, 2);
  assert.equal(p.cached, 0.01);
  assert.ok(p.peak && p.peak.in === 1, '峰谷档也要按倍率打折');
  assert.match(p.via, /官方价 ×0\.5/);
});

test('账户口径：按月付（所有模型都是固定支出，连没听过的模型也不会"未定价"）', () => {
  const cfg = { api: { model: CURRENT, useOfficialPrice: true, costMode: 'subscription', costMonthlyFee: 68 } };
  const known = priceOf(CURRENT, cfg, { vendor: 'cmd' });
  assert.equal(known.billing, 'flat');
  assert.equal(known.amount, 68);
  assert.equal(known.kind, 'actual');
  assert.equal(known.unpriced, false);

  const unknown = priceOf('some-brand-new-model', cfg, { vendor: 'cmd' });
  assert.equal(unknown.billing, 'flat', '按月付口径下，未知模型也不该显示未定价');
  assert.equal(unknown.unpriced, false);
  assert.equal(unknown.amount, 68);
});

test('没有价格的模型：默认按"当前模型"的价估算（可关）', () => {
  const cfg = { api: { model: CURRENT, useOfficialPrice: true } };
  const p = priceOf('mystery-model-x', cfg, { vendor: 'cmd' });
  assert.equal(p.source, 'fallback-model');
  assert.equal(p.kind, 'estimate', '这是估算，不是实付');
  assert.equal(p.in, 1, '沿用当前模型的价');
  assert.equal(p.unpriced, false);
  assert.match(p.via, /按当前模型/);

  const off = priceOf('mystery-model-x', { api: { ...cfg.api, fallbackToCurrentModel: false } }, { vendor: 'cmd' });
  assert.equal(off.unpriced, true, '关掉兜底后回到未定价');

  // 当前模型自己也没价 → 没法兜底，仍是未定价
  const noBase = priceOf('mystery-model-x', { api: { model: 'another-unknown', useOfficialPrice: true } }, { vendor: 'cmd' });
  assert.equal(noBase.unpriced, true);
});

test('手填的价优先于账户口径', () => {
  const cfg = {
    api: {
      model: CURRENT,
      useOfficialPrice: true,
      costMode: 'subscription',
      costMonthlyFee: 68,
      modelPrices: { [`cmd：${CURRENT}`]: { in: 1.5, out: 6 } }
    }
  };
  const p = priceOf(CURRENT, cfg, { vendor: 'cmd' });
  assert.equal(p.source, 'channel');
  assert.equal(p.billing, 'token');
  assert.equal(p.in, 1.5);
});

test('costModeOf 归一化', () => {
  assert.deepEqual(prices.costModeOf({ api: { costMode: 'MULTIPLIER', costMultiplier: '0.3' } }), { mode: 'multiplier', multiplier: 0.3, monthlyFee: 0 });
  assert.deepEqual(prices.costModeOf({ api: { costMode: 'subscription', costMonthlyFee: '68' } }), { mode: 'subscription', multiplier: 1, monthlyFee: 68 });
  assert.deepEqual(prices.costModeOf({}), { mode: 'official', multiplier: 1, monthlyFee: 0 });
  assert.deepEqual(prices.costModeOf({ api: { costMode: '乱填的' } }), { mode: 'official', multiplier: 1, monthlyFee: 0 });
});

/* ── 带时间区间的别名：历史成本要按当时的规则算 ── */

test('aliasTargetAt：区间内/区间外/过期/无时间上下文', () => {
  const ranged = { to: 'flash', from: '2026-09-14T12:00:00+08:00' };
  const from = Date.parse('2026-09-14T12:00:00+08:00');
  assert.equal(prices.aliasTargetAt(ranged, from - 1000), '', '区间之前不生效');
  assert.equal(prices.aliasTargetAt(ranged, from + 1000), 'flash', '区间之后生效');
  assert.equal(prices.aliasTargetAt(ranged, 0), 'flash', '没有时间上下文（界面预览）时按"还没过期"处理');

  const expired = { to: 'old-flash', until: '2026-01-01T00:00:00+08:00' };
  assert.equal(prices.aliasTargetAt(expired, Date.parse('2026-06-01T00:00:00+08:00')), '', '过期别名不用');
  assert.equal(prices.aliasTargetAt(expired, 0), '', '没有时间上下文时，已过期的别名也不该用');

  assert.equal(prices.aliasTargetAt('plain', 0), 'plain', '字符串形式永远生效');
  assert.equal(prices.aliasTargetAt({ to: '' }, 0), '');
  assert.equal(prices.aliasTargetAt(null, 0), '');
});

test('内置的时间区间别名：deepseek-v4-pro 在 2026-09-14 之后按 Flash 价算', () => {
  const before = prices.resolveOfficialPrice('deepseek-v4-pro', { at: Date.parse('2026-09-10T10:00:00+08:00') });
  assert.equal(before.matched, 'deepseek-v4-pro', '路由之前用 v4-pro 自己的条目');
  assert.equal(before.in, 4.5);

  const after = prices.resolveOfficialPrice('deepseek-v4-pro', { at: Date.parse('2026-09-18T10:00:00+08:00') });
  assert.equal(after.matched, 'deepseek-flash', '路由之后按 Flash 价');
  assert.equal(after.in, 1);
  assert.match(after.via, /该时段的别名规则/);

  // 逐条计价时也要按各自发生时间判：同一批行里前后两天的价不一样
  const cfg = { api: { useOfficialPrice: true } };
  const oldRow = priceOf('deepseek-v4-pro', cfg, { vendor: '', at: Date.parse('2026-09-10T10:00:00+08:00') });
  const newRow = priceOf('deepseek-v4-pro', cfg, { vendor: '', at: Date.parse('2026-09-18T10:00:00+08:00') });
  assert.equal(oldRow.in, 4.5);
  assert.equal(newRow.in, 1);
});

test('自定义价与全局兜底单价都算"已定价"', () => {
  const custom = priceOf('my-private-model', {
    api: { useOfficialPrice: false, modelPrices: { 'my-private-model': { in: 2, out: 8 } } }
  });
  assert.equal(custom.source, 'custom');
  assert.equal(custom.in, 2);
  assert.equal(custom.unpriced, false);

  const manual = priceOf('whatever-model', {
    api: { useOfficialPrice: false, priceInputPerM: 0.15, priceOutputPerM: 0.6, priceCachedPerM: 0.003 }
  });
  assert.equal(manual.source, 'manual');
  assert.equal(manual.in, 0.15);
  assert.equal(manual.unpriced, false);
});

test('远程价格表能带别名，且远程条目优先', () => {
  prices.setRemotePrices({}, { 'weird-alias-name': 'deepseek-flash' });
  const viaRemoteAlias = priceOf('weird-alias-name');
  assert.equal(viaRemoteAlias.matched, 'deepseek-flash');
  assert.equal(viaRemoteAlias.confidence, 'alias');

  prices.setRemotePrices(
    { 'acme-ds-flash': { in: 9, out: 18, cached: 0.09 } },
    { 'deepseek-v4.1-flash': 'acme-ds-flash' }
  );
  const overridden = priceOf('deepseek-v4.1-flash');
  assert.equal(overridden.matched, 'acme-ds-flash');
  assert.equal(overridden.in, 9, '远程表覆盖内置价，别名指向它');

  prices.setRemotePrices({});
  assert.equal(priceOf('weird-alias-name').unpriced, true, '清空远程表后退回内置别名表');
});

test('远程价格表载荷支持 aliases，且不会把 aliases 当模型', () => {
  const norm = feed.normalizePriceFeed({
    prices: { 'acme-flash': { in: 1, out: 2 } },
    aliases: { 'ACME/FLASH': 'acme-flash', 'bad': 'acme-flash', 'self': 'self' }
  });
  assert.ok(norm, '载荷可用');
  assert.deepEqual(Object.keys(norm.prices), ['acme-flash']);
  assert.deepEqual(norm.aliases, { 'acme/flash': 'acme-flash', bad: 'acme-flash' }, '别名小写化，自指的被丢掉');

  const bare = feed.normalizePriceFeed({
    'x-flash': { in: 3, out: 6 },
    aliases: { 'y-flash': 'x-flash' },
    updated: '2026-09-21'
  });
  assert.deepEqual(Object.keys(bare.prices), ['x-flash'], 'updated/aliases 这类元数据键不算模型');
  assert.deepEqual(bare.aliases, { 'y-flash': 'x-flash' });
});

test('前端用的 matchPriceTable 与后端 resolveOfficialPrice 口径一致', () => {
  const table = prices.listOfficialPrices();
  const ids = [
    'deepseek/deepseek-v4.1-flash',
    'deepseek-v4-flash-0731',
    'kimi-k3-preview',
    'z-ai/glm-5.3-insider',
    'gone-model-xyz'
  ];
  for (const id of ids) {
    const backend = prices.resolveOfficialPrice(id);
    const frontend = prices.matchPriceTable(id, table);
    assert.equal(
      frontend ? frontend.matched : null,
      backend ? backend.matched : null,
      `${id} 的匹配结果要一致`
    );
    assert.equal(frontend ? frontend.confidence : 'none', backend ? backend.confidence : 'none');
  }
});

/* ── 兜底估算也要按"每条调用自己的时间"取别名 ── */

test('兜底估算（按当前模型估价）不能拿"现在"的别名规则改写历史', () => {
  // 内置别名表：deepseek-v4-pro 从 2026-09-14T12:00(+08:00) 起路由到 flash。
  // 历史行必须按当时的规则算，否则 9-14 之前那些调用会被按 flash 的价低估数倍。
  const cfg = { api: { model: 'deepseek-v4-pro', useOfficialPrice: true, fallbackToCurrentModel: true } };
  const after9 = prices.resolveModelPrice('some-unknown-model', cfg, null, { at: Date.parse('2026-09-18T07:30:00+08:00') });
  assert.equal(after9.source, 'fallback-model');
  assert.equal(after9.in, 1, '9-14 之后 v4-pro 已路由到 flash');

  const before9 = prices.resolveModelPrice('some-unknown-model', cfg, null, { at: Date.parse('2026-09-10T07:30:00+08:00') });
  assert.equal(before9.source, 'fallback-model');
  assert.equal(before9.in, 4.5, '9-14 之前 v4-pro 还是它自己的价（带 from 的别名不回溯）');
});

/* ── 0 是合法价，不是"没填" ── */

test('手填全 0 的价 = 明确写出来的免费，不再回落到官方表', () => {
  const free = { api: { model: CURRENT, useOfficialPrice: true, modelPrices: { 'free-model': { in: 0, out: 0 } } } };
  const p = prices.resolveModelPrice('free-model', free, null, {});
  assert.equal(p.source, 'custom', '0/0 是用户写的价，不能被当成"没填"');
  assert.equal(p.in, 0);
  assert.equal(p.out, 0);
  assert.equal(p.unpriced, false, '免费 ≠ 未定价');

  // 渠道价同理
  const channelFree = {
    api: { useOfficialPrice: true, modelPrices: { '某渠道：free-model': { in: 0, out: 0 } } }
  };
  const c = prices.resolveModelPrice('free-model', channelFree, null, { vendor: '某渠道' });
  assert.equal(c.source, 'channel');
  assert.equal(c.in, 0);

  // 空条目 / 没写字段的条目仍然算"没填"（回落到价格表，而不是变成免费）
  const empty = { api: { useOfficialPrice: true, modelPrices: { [CURRENT]: { note: '还没填价' } } } };
  assert.notEqual(prices.resolveModelPrice(CURRENT, empty, null, {}).source, 'custom');
});

test('渠道倍率填 0 = 这个渠道不花钱（不再被当成没填而按原价算）', () => {
  const cfg = { api: { model: CURRENT, useOfficialPrice: true, costMode: 'multiplier', costMultiplier: 0 } };
  const p = priceOf(CURRENT, cfg, { vendor: 'cmd' });
  assert.equal(p.source, 'multiplier');
  assert.equal(p.in, 0);
  assert.equal(p.out, 0);
  assert.match(p.via, /官方价 ×0/);

  // 没填 / 写坏仍然是 1 倍
  assert.equal(prices.parseMultiplier(undefined), 1);
  assert.equal(prices.parseMultiplier(''), 1);
  assert.equal(prices.parseMultiplier('abc'), 1);
  assert.equal(prices.parseMultiplier(-2), 1);
  assert.equal(prices.parseMultiplier(0), 0);
  assert.equal(prices.parseMultiplier('0.5'), 0.5);
});

test('别名的时间边界写错：整条别名叫它失效，不按"没有边界"处理', () => {
  const ok = { to: 'flash', until: '2026-09-14T00:00:00+08:00' };
  assert.equal(prices.aliasTargetAt(ok, Date.parse('2026-09-10T00:00:00+08:00')), 'flash');
  assert.equal(prices.aliasTargetAt(ok, Date.parse('2026-09-20T00:00:00+08:00')), '');

  // until 写错（垃圾字符串）：不能"永不失效"，而是整条别名不可用
  assert.equal(prices.aliasTargetAt({ to: 'flash', until: '不是时间' }, Date.parse('2026-09-20T00:00:00+08:00')), '');
  // from 写错：不能回溯到全部历史
  assert.equal(prices.aliasTargetAt({ to: 'flash', from: '2026-13-45' }, Date.parse('2020-01-01T00:00:00+08:00')), '');
  // 没写边界 = 永久别名，照常生效
  assert.equal(prices.aliasTargetAt({ to: 'flash' }, Date.parse('2020-01-01T00:00:00+08:00')), 'flash');
});
