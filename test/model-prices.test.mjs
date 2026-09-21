import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-model-prices-'));
process.env.QQ_AGENT_DATA_DIR = root;

const prices = await import('../src/model-prices.js');
const feed = await import('../src/price-feed.js');

after(() => {
  prices.setRemotePrices({});   // 还原全局状态，别影响其他用例
  fs.rmSync(root, { recursive: true, force: true });
});

const OFFICIAL = { api: { useOfficialPrice: true } };
const priceOf = (id, cfg = OFFICIAL) => prices.resolveModelPrice(id, cfg);

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
  assert.equal(bare.source, 'none');
  assert.equal(bare.unpriced, true);

  // 官方免费（单价 0）≠ 未定价：这是"真的不要钱"
  const freeModel = priceOf('glm-4.7-flash');
  assert.equal(freeModel.unpriced, false);
  assert.equal(freeModel.in, 0);
  assert.equal(freeModel.out, 0);
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
