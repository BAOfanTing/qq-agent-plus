// 远程价格表的刷新行为：并发去重、地址切换、生效来源标记。
//
// 背景（2026-09-21）：手动「立即拉取」和启动/24h 定时那次撞上时，两次刷新会互相
// 覆盖（后返回的旧结果赢）；换了地址又没拉成功时，界面会拿新地址 + 旧数据说"已生效"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-price-feed-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 上可能还被占用 */ } });

const feed = await import('../src/pricing/price-feed.js');

/** 可控延迟的假 fetch：用它把两次刷新的先后顺序摆出来。 */
function fakeFetch(payload, delayMs = 0) {
  const impl = async () => {
    impl.calls += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (payload === null) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => payload };
  };
  impl.calls = 0;
  return impl;
}

const PAYLOAD = { prices: { 'demo-model': { in: 1.5, out: 4.5 } } };

test('同一组地址的并发刷新只发一次请求（结果共用，谁也不覆盖谁）', async () => {
  const impl = fakeFetch(PAYLOAD, 30);
  const url = 'https://same.example.com/prices.json';
  const [a, b] = await Promise.all([
    feed.refreshPriceFeed(url, { fetchImpl: impl }),
    feed.refreshPriceFeed(url, { fetchImpl: impl })
  ]);
  assert.equal(impl.calls, 1, '并发刷新应合并成一次请求');
  assert.equal(a.sourceUrl, url);
  assert.equal(b.sourceUrl, url);
  assert.equal(b.count, 1);
});

test('刷新中地址被改：等前一次跑完再跑新的，最终生效的是新地址', async () => {
  const oldImpl = fakeFetch({ prices: { 'old-model': { in: 9, out: 9 } } }, 40);
  const newImpl = fakeFetch({ prices: { 'new-model': { in: 1, out: 1 } } }, 0);
  const first = feed.refreshPriceFeed('https://old.example.com/p.json', { fetchImpl: oldImpl });
  const second = feed.refreshPriceFeed('https://new.example.com/p.json', { fetchImpl: newImpl });
  await Promise.resolve();
  assert.equal(newImpl.calls, 0, '地址不同时要排队，不能同时打两次');
  const [, after] = await Promise.all([first, second]);
  assert.equal(newImpl.calls, 1);
  assert.equal(after.sourceUrl, 'https://new.example.com/p.json');
  const status = feed.priceFeedStatus();
  assert.equal(status.sourceUrl, 'https://new.example.com/p.json', '旧地址的结果不能盖回新地址');
  assert.equal(status.sourceStale, false);
});

test('换了地址但没拉成功：标记 sourceStale，并说明生效的仍是旧地址', async () => {
  const good = fakeFetch(PAYLOAD, 0);
  const okUrl = 'https://ok.example.com/prices.json';
  await feed.refreshPriceFeed(okUrl, { fetchImpl: good });

  const badUrl = 'https://broken.example.com/prices.json';
  const failed = await feed.refreshPriceFeed(badUrl, { fetchImpl: fakeFetch(null, 0) });
  assert.equal(failed.ok, false);
  assert.equal(failed.url, badUrl, 'url 是配置里的地址');
  assert.equal(failed.sourceUrl, okUrl, '生效的还是上一次成功拉到的那个地址');
  assert.equal(failed.sourceStale, true, '界面要靠这个标记说出"新地址还没生效"');

  const again = await feed.refreshPriceFeed(okUrl, { fetchImpl: good });
  assert.equal(again.sourceStale, false, '拉成功了就不再是 stale');
});

test('切成 none：当场回落到内置表，不再沿用已拉到的远程表', async () => {
  const { resolveModelPrice } = await import('../src/pricing/model-prices.js');
  const url = 'https://none.example.com/prices.json';
  const remote = { prices: { 'demo-model': { in: 111, out: 222 } } };
  await feed.refreshPriceFeed(url, { fetchImpl: fakeFetch(remote, 0) });
  feed.initPriceFeed(url);
  const withRemote = resolveModelPrice('demo-model');
  assert.equal(withRemote.in, 111, '先确认远程表确实生效了');

  // 管理端把地址改成 none（设置页保存就会走到这里）
  feed.initPriceFeed('none');
  const status = feed.priceFeedStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.source, 'builtin', '状态要说明现在用的是内置表');
  assert.notEqual(resolveModelPrice('demo-model').in, 111, '本次进程就要失效，不能等重启');
});

test('none 之后重新启用：磁盘缓存顶上，拉到新的再覆盖', async () => {
  const { resolveModelPrice } = await import('../src/pricing/model-prices.js');
  const url = 'https://again.example.com/prices.json';
  await feed.refreshPriceFeed(url, { fetchImpl: fakeFetch({ prices: { 'again-model': { in: 5, out: 6 } } }, 0) });
  feed.initPriceFeed('none');
  assert.notEqual(resolveModelPrice('again-model').in, 5);
  // 缓存是有意保留的：重新启用时先用它顶上（离线也不至于没有价）
  feed.initPriceFeed(url);
  assert.equal(resolveModelPrice('again-model').in, 5, '缓存里的价要先顶上');
});
