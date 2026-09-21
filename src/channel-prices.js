// 每渠道一份价目表：用户给某个渠道配一个 URL，我们拉它的价目，
// 拉到的价只在该渠道的调用上生效（用户手填的渠道价仍然优先）。
//
// 与 src/price-feed.js 的分工：
//   price-feed     一张全局表，按模型 id 覆盖内置表（项目/社区共享的公共参考价）
//   channel-prices 按渠道分表（用户自己那家渠道的实付价目）
// 存储：data/channel-prices.json —— 拉取结果与状态落盘，重启先用缓存；
// 配置：api.channelPriceFeeds = [{ vendor, url }]（用户意图留在 config 里）。
//
// 约束沿用 price-feed：全异步、错误都吞进状态、任何函数都不把异常抛给调用方。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { setChannelPrices } from './model-prices.js';
import { normalizePriceFeed } from './price-feed.js';

const FILE = path.join(DATA_DIR, 'channel-prices.json');
const CACHE_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;
const STALE_MS = 24 * 3600 * 1000;   // 启动时超过 24h 的缓存顺手刷新一次

/** { [vendor]: { url, ok, error, fetchedAt, count, dropped, prices } } */
let feeds = {};

function writeFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, feeds }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch { /* 写不进去不影响查价（内存里已经有表） */ }
}

/** 把内存里的表注入查价层。 */
function injectAll() {
  for (const [vendor, feed] of Object.entries(feeds)) {
    setChannelPrices(vendor, feed?.prices || null);
  }
}

/** 启动时调用：先吃磁盘缓存（同步注入），再按需后台刷新。 */
export function initChannelPrices(feedsConfig = []) {
  // 1) 读缓存（配置里已经删掉的渠道不再注入）
  const wanted = new Set((Array.isArray(feedsConfig) ? feedsConfig : [])
    .map((f) => String(f?.vendor || '').trim())
    .filter(Boolean));
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const cached = data?.version === CACHE_VERSION && data.feeds && typeof data.feeds === 'object' ? data.feeds : {};
    feeds = {};
    for (const [vendor, feed] of Object.entries(cached)) {
      if (!wanted.has(vendor)) continue;
      feeds[vendor] = feed;
    }
  } catch {
    feeds = {};
  }
  injectAll();

  // 2) 缓存缺失或过旧的，后台拉一次（不阻塞启动，失败只记状态）
  for (const item of (Array.isArray(feedsConfig) ? feedsConfig : [])) {
    const vendor = String(item?.vendor || '').trim();
    const url = String(item?.url || '').trim();
    if (!vendor || !url) continue;
    const feed = feeds[vendor];
    const fresh = feed?.ok === true && Number(feed.fetchedAt || 0) > 0
      && Date.now() - Number(feed.fetchedAt) < STALE_MS;
    if (fresh && feed.url === url) continue;
    applyFeed(vendor, url);   // 立即重新拉（异步）
  }
}

/** 拉一个渠道的价目并落盘/注入（内部吞异常）。 */
export async function refreshChannelFeed(vendor, url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const v = String(vendor || '').trim();
  const target = String(url || '').trim();
  if (!v || !target) return channelPriceStatus();
  try {
    const res = await fetchImpl(target, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(Number(options.timeoutMs) || FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => { throw new Error('返回的不是合法 JSON'); });
    const norm = normalizePriceFeed(payload);
    if (!norm || !Object.keys(norm.prices).length) throw new Error('没有可用的价格条目（需要 in/out 价目或倍率表）');
    feeds[v] = {
      url: target,
      ok: true,
      error: '',
      fetchedAt: Date.now(),
      count: Object.keys(norm.prices).length,
      dropped: norm.dropped || 0,
      prices: norm.prices
    };
    setChannelPrices(v, norm.prices);
  } catch (error) {
    const previous = feeds[v] || {};
    feeds[v] = {
      url: target,
      ok: false,
      error: String(error?.cause?.message ?? error?.message ?? error),
      fetchedAt: Date.now(),
      count: previous.count || 0,
      dropped: previous.dropped || 0,
      prices: previous.prices || {}   // 失败不清表：继续用上一次拉到的
    };
    if (feeds[v].prices && Object.keys(feeds[v].prices).length) setChannelPrices(v, feeds[v].prices);
    else setChannelPrices(v, null);
  }
  writeFile();
  return channelPriceStatus();
}

/** 不等待地拉一次（给启动时的后台刷新用）。 */
function applyFeed(vendor, url) {
  refreshChannelFeed(vendor, url).catch(() => { /* 内部已吞，这里是第二道保险 */ });
}

/** 删除一个渠道的价目表（同时从查价层撤掉）。 */
export function removeChannelFeed(vendor) {
  const v = String(vendor || '').trim();
  if (!v) return channelPriceStatus();
  delete feeds[v];
  setChannelPrices(v, null);
  writeFile();
  return channelPriceStatus();
}

/** 给控制台看的状态：每个渠道的地址、条数、上次时间、错误。 */
export function channelPriceStatus() {
  return Object.entries(feeds)
    .map(([vendor, feed]) => ({
      vendor,
      url: String(feed?.url || ''),
      ok: feed?.ok === true,
      error: String(feed?.error || ''),
      fetchedAt: Number(feed?.fetchedAt || 0),
      count: Number(feed?.count || 0),
      dropped: Number(feed?.dropped || 0)
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}

/** 测试用：当前注入的渠道数与条目数。 */
export function channelPriceCounts() {
  const out = {};
  for (const [vendor, feed] of Object.entries(feeds)) {
    out[vendor] = Object.keys(feed?.prices || {}).length;
  }
  return out;
}
