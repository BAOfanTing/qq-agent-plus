import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-price-probe-'));
process.env.QQ_AGENT_DATA_DIR = root;

const probe = await import('../src/price-probe.js');
const channel = await import('../src/channel-prices.js');
const prices = await import('../src/model-prices.js');

after(() => {
  prices.setChannelPrices('demo-渠道', null);
  fs.rmSync(root, { recursive: true, force: true });
});

/** 假 fetch：按 URL 返回预设载荷。 */
function fakeFetch(routes) {
  const impl = async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    impl.calls.push(String(url));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const route = routes[key];
    if (route && route.__status && route.__status !== 200) {
      return { ok: false, status: route.__status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => route };
  };
  impl.calls = [];
  return impl;
}

const ONE_API = {
  data: [
    { model_name: 'deepseek/deepseek-v4.1-flash', quota_type: 0, model_ratio: 0.5, completion_ratio: 4 },
    { model_name: 'glm/glm-5.3', quota_type: 0, model_ratio: 4, completion_ratio: 3.5 },
    { model_name: 'per-call-model', quota_type: 1, model_ratio: 3 }
  ],
  group_ratio: { default: 1, vip: 0.8 }
};

test('one-api 倍率表 → 元/百万 token（含汇率与分组）', () => {
  const table = probe.oneApiPricesToTable(ONE_API, 7.2);
  assert.equal(table.group, 'default');
  assert.equal(table.groupRatio, 1);
  assert.equal(table.skipped, 1, '按次计费的条目要跳过');
  // 0.5 倍率 → 0.5 × 2 美元/百万 = $1 → ¥7.2；输出 ×4
  assert.equal(table.prices['deepseek/deepseek-v4.1-flash'].in, 7.2);
  assert.equal(table.prices['deepseek/deepseek-v4.1-flash'].out, 28.8);
  assert.equal(table.prices['deepseek/deepseek-v4.1-flash'].cached, 7.2, '渠道倍率没有缓存档，按输入价');
  assert.match(table.prices['glm/glm-5.3'].note, /倍率 4/);
  assert.equal(table.prices['glm/glm-5.3'].out, Number((4 * 2 * 3.5 * 7.2).toFixed(6)));
});

test('没给汇率就用 7.2，并在条目备注里写明', () => {
  const table = probe.oneApiPricesToTable({ data: [{ model_name: 'x', model_ratio: 1 }] }, 0);
  assert.equal(table.prices.x.in, 14.4);
  assert.match(table.prices.x.note, /汇率 7.2/);
});

test('探测：识别 one-api 站点，并从 /api/status 取汇率', async () => {
  const github = fakeFetch({
    '/api/pricing': ONE_API,
    '/api/status': { data: { usd_exchange_rate: 7.31 } }
  });
  const res = await probe.probeChannelPrices({ url: 'https://api.example.com/provider/v1', fetchImpl: github });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'one-api');
  assert.equal(res.sourceUrl, 'https://api.example.com/api/pricing');
  assert.equal(res.usdRate, 7.31);
  assert.equal(res.modelCount, 2);
  assert.equal(res.skipped, 1);
  assert.ok(res.prices['deepseek/deepseek-v4.1-flash'].in > 7 && res.prices['deepseek/deepseek-v4.1-flash'].in < 7.4);
});

test('探测：自家价目表形状直接采用（元/百万，不换算）', async () => {
  const github = fakeFetch({
    '/api/pricing': { prices: { 'my-model': { in: 1.5, out: 6, cached: 0.1 } } }
  });
  const res = await probe.probeChannelPrices({ url: 'https://api.example.com', fetchImpl: github });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'table');
  assert.equal(res.prices['my-model'].in, 1.5);
  assert.equal(res.modelCount, 1);
});

test('探测：认不出来就明确失败，并把试过的地址列出来', async () => {
  const github = fakeFetch({ '/api/pricing': { hello: 'world' } });
  const res = await probe.probeChannelPrices({ url: 'https://api.example.com', fetchImpl: github });
  assert.equal(res.ok, false);
  assert.match(res.error, /探测失败/);
  assert.ok(res.tried.length >= 2, '候选地址都试过');
  assert.equal(Object.keys(res.prices).length, 0);
});

test('候选地址：站点根优先，去重，也能直接填 /api/pricing', () => {
  assert.deepEqual(
    probe.probeCandidates('https://api.commandcode.ai/provider/v1'),
    [
      'https://api.commandcode.ai/api/pricing',
      'https://api.commandcode.ai/api/status',
      'https://api.commandcode.ai/provider/v1/api/pricing'
    ]
  );
  assert.deepEqual(
    probe.probeCandidates('https://api.example.com/api/pricing'),
    ['https://api.example.com/api/pricing', 'https://api.example.com/api/status']
  );
  assert.deepEqual(probe.probeCandidates(''), []);
});

test('渠道价目表参与查价：手填的价仍然优先', () => {
  prices.setChannelPrices('demo-渠道', { 'my-model': { in: 0.8, out: 3.2 } });
  try {
    const fromTable = prices.resolveModelPrice('my-model', { api: { useOfficialPrice: true } }, null, { vendor: 'demo-渠道' });
    assert.equal(fromTable.source, 'channel-table');
    assert.equal(fromTable.kind, 'actual');
    assert.equal(fromTable.in, 0.8);

    // 别的渠道不受影响（回落官方价或未定价）
    const other = prices.resolveModelPrice('my-model', { api: { useOfficialPrice: true } }, null, { vendor: '别的站' });
    assert.equal(other.unpriced, true);

    // 手填的模型价优先于渠道价目表
    const manual = prices.resolveModelPrice(
      'my-model',
      { api: { useOfficialPrice: true, modelPrices: { 'my-model': { in: 9, out: 36 } } } },
      null,
      { vendor: 'demo-渠道' }
    );
    assert.equal(manual.source, 'custom');
    assert.equal(manual.in, 9);

    // 手填的渠道价更优先
    const manualChannel = prices.resolveModelPrice(
      'my-model',
      { api: { useOfficialPrice: true, modelPrices: { 'demo-渠道：my-model': { in: 5, out: 20 } } } },
      null,
      { vendor: 'demo-渠道' }
    );
    assert.equal(manualChannel.source, 'channel');
    assert.equal(manualChannel.in, 5);
  } finally {
    prices.setChannelPrices('demo-渠道', null);
  }
});

test('渠道价目表落盘 + 拉取失败时保留上一次的表', async () => {
  const good = fakeFetch({ '/pricing.json': { prices: { 'keep-model': { in: 2, out: 8 } } } });
  let status = await channel.refreshChannelFeed('落盘渠道', 'https://data.example.com/pricing.json', { fetchImpl: good });
  assert.equal(status.length, 1);
  assert.equal(status[0].ok, true);
  assert.equal(status[0].count, 1);
  assert.deepEqual(channel.channelPriceCounts()['落盘渠道'], 1);

  const bad = fakeFetch({ '/pricing.json': { __status: 500 } });
  status = await channel.refreshChannelFeed('落盘渠道', 'https://data.example.com/pricing.json', { fetchImpl: bad });
  assert.equal(status[0].ok, false);
  assert.match(status[0].error, /HTTP 500/);
  assert.deepEqual(channel.channelPriceCounts()['落盘渠道'], 1, '失败不清表，继续用上一次的价');

  // 重启：缓存能读回来（配置里有这个渠道时才注入）
  channel.initChannelPrices([{ vendor: '落盘渠道', url: 'https://data.example.com/pricing.json' }]);
  assert.deepEqual(channel.channelPriceCounts()['落盘渠道'], 1);

  // 配置里删掉这个渠道 → 不再注入
  channel.initChannelPrices([]);
  assert.equal(channel.channelPriceCounts()['落盘渠道'], undefined);

  channel.removeChannelFeed('落盘渠道');
  assert.equal(channel.channelPriceStatus().length, 0);
});

/* ── 自动探测（零配置路径） ── */

test('自动探测：成功就登记成渠道价目表并生效', async () => {
  const github = fakeFetch({
    '/api/pricing': { data: [{ model_name: 'auto-model', quota_type: 0, model_ratio: 1, completion_ratio: 2 }] }
  });
  let savedPatch = null;
  const res = await channel.maybeAutoProbeChannel({
    baseUrl: 'https://auto.example.com/provider/v1',
    vendor: '自动渠道',
    feedsConfig: [],
    options: {
      fetchImpl: github,
      getConfig: () => ({ api: { channelPriceFeeds: [] } }),
      updateConfig: (patch) => { savedPatch = patch; }
    }
  });
  assert.equal(res.probed, true);
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.ok(savedPatch, '要把渠道价目表写进配置');
  assert.equal(savedPatch.api.channelPriceFeeds[0].vendor, '自动渠道');
  assert.equal(savedPatch.api.channelPriceFeeds[0].auto, true);
  assert.deepEqual(channel.channelPriceCounts()['自动渠道'], 1);
  // 价格也真的生效了（该渠道下 1 倍率 = ¥14.4/百万）
  const p = prices.resolveModelPrice('auto-model', { api: { useOfficialPrice: true } }, null, { vendor: '自动渠道' });
  assert.equal(p.source, 'channel-table');
  assert.ok(p.in > 14 && p.in < 15);
  channel.removeChannelFeed('自动渠道');
});

test('自动探测：失败静默、不登记、不抛异常', async () => {
  const github = fakeFetch({ '/api/pricing': { hello: 'world' } });
  let called = 0;
  const res = await channel.maybeAutoProbeChannel({
    baseUrl: 'https://nope.example.com',
    vendor: '失败的渠道',
    feedsConfig: [],
    options: {
      fetchImpl: github,
      getConfig: () => ({ api: { channelPriceFeeds: [] } }),
      updateConfig: () => { called += 1; }
    }
  });
  assert.equal(res.probed, true);
  assert.equal(res.ok, false);
  assert.equal(called, 0, '失败不写配置');
  assert.equal(channel.channelPriceCounts()['失败的渠道'], undefined);
});

test('自动探测：已配过或刚探过就跳过', async () => {
  const github = fakeFetch({ '/api/pricing': { data: [{ model_name: 'x', model_ratio: 1 }] } });
  const configured = await channel.maybeAutoProbeChannel({
    baseUrl: 'https://x.example.com',
    vendor: '已有渠道',
    feedsConfig: [{ vendor: '已有渠道', url: 'https://x.example.com/pricing.json' }],
    options: { fetchImpl: github }
  });
  assert.equal(configured.probed, false);
  assert.equal(configured.reason, 'configured');

  const noUrl = await channel.maybeAutoProbeChannel({ baseUrl: '', vendor: '空地址', feedsConfig: [] });
  assert.equal(noUrl.probed, false);
  assert.equal(noUrl.reason, 'no-target');
});
