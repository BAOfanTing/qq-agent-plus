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
import { DATA_DIR, updateConfig } from './config.js';
import { setChannelPrices } from './model-prices.js';
import { normalizePriceFeed } from './price-feed.js';
import { probeChannelPrices } from './price-probe.js';

const FILE = path.join(DATA_DIR, 'channel-prices.json');
const CACHE_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;
const STALE_MS = 24 * 3600 * 1000;   // 启动时超过 24h 的缓存顺手刷新一次
const AUTO_PROBE_TTL_MS = 24 * 3600 * 1000;   // 同一个渠道 24h 内只自动探一次

/** { [vendor]: { url, ok, error, fetchedAt, count, dropped, prices } } */
let feeds = {};
/** { [vendor]: 上次自动探测时间 } —— 探测失败也要记，避免每次重启都去敲站点 */
let autoProbeAt = {};

function writeFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, feeds, autoProbeAt }, null, 2), { mode: 0o600 });
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
    autoProbeAt = (data?.autoProbeAt && typeof data.autoProbeAt === 'object') ? data.autoProbeAt : {};
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
      dropped: Number(feed?.dropped || 0),
      auto: feed?.auto === true
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

/**
 * 自动探测（"零配置"路径）：用户填了渠道地址但还没配任何渠道价目表时，
 * 后台自己探一次 —— 成功就把结果登记成该渠道的价目表（写进 config，
 * 之后按 24h 缓存刷新）；失败**完全静默**，回落到官方价估算。
 *
 * 约束：
 *   - 同一个渠道 24h 内只试一次（成功失败都算），避免每次重启都去敲对方站点
 *   - 已经有该渠道的价目表时不再探测
 *   - 任何异常都吞掉：这个函数绝不把错误抛给调用方
 */
export async function maybeAutoProbeChannel({ baseUrl, vendor, feedsConfig = [], options = {} } = {}) {
  try {
    const url = String(baseUrl || '').trim();
    const channel = String(vendor || '').trim();
    if (!url || !channel || !/^https?:\/\//i.test(url)) return { probed: false, reason: 'no-target' };
    const configured = (Array.isArray(feedsConfig) ? feedsConfig : [])
      .some((f) => String(f?.vendor || '').trim() === channel);
    if (configured) return { probed: false, reason: 'configured' };
    const last = Number(autoProbeAt[channel] || 0);
    if (last && Date.now() - last < AUTO_PROBE_TTL_MS) return { probed: false, reason: 'recent' };

    autoProbeAt[channel] = Date.now();
    writeFile();
    const probe = await probeChannelPrices({
      url,
      timeoutMs: Number(options.timeoutMs) || 12000,
      fetchImpl: options.fetchImpl
    });
    if (!probe.ok || !Object.keys(probe.prices || {}).length) {
      return { probed: true, ok: false, error: probe.error || '没有识别到价目' };
    }
    // 登记成该渠道的价目表（写 config + 落盘 + 注入）
    try {
      const current = options.getConfig ? options.getConfig() : null;
      const feeds = Array.isArray(current?.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
      if (!feeds.some((f) => String(f?.vendor || '').trim() === channel)) {
        const write = options.updateConfig || updateConfig;
        write({ api: { ...(current?.api || {}), channelPriceFeeds: [...feeds, { vendor: channel, url, auto: true }] } });
      }
    } catch { /* 写不进 config 也要把表用起来 */ }
    feeds[channel] = {
      url,
      ok: true,
      error: '',
      fetchedAt: Date.now(),
      count: Object.keys(probe.prices).length,
      dropped: probe.skipped || 0,
      prices: probe.prices,
      auto: true,
      source: probe.kind
    };
    setChannelPrices(channel, probe.prices);
    writeFile();
    return { probed: true, ok: true, count: Object.keys(probe.prices).length, kind: probe.kind };
  } catch (error) {
    return { probed: true, ok: false, error: String(error?.message ?? error) };
  }
}
