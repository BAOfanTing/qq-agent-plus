// RSS / Atom 最小适配器：只读 feed 里的标题、链接、摘要、时间和分类，不抓正文。
// 不引入 XML 依赖：只覆盖 RSS 2.0 与 Atom 的常见字段；解析失败只记错误，不影响其它来源。
import crypto from 'node:crypto';
import { safeFetch } from '../llm/safe-fetch.js';

const MAX_FEED_BYTES = 2 * 1024 * 1024;

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const cp = Number(n);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const cp = parseInt(n, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });
}

function stripTags(text) {
  // 先还原 CDATA，再剥 HTML 标签：反过来会把 <![CDATA[正文]]> 整段当标签吃掉。
  const decoded = decodeEntities(String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? stripTags(m[1]) : '';
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => {
    const tag = m[0];
    const href = /\bhref=["']([^"']+)["']/i.exec(tag);
    const rel = /\brel=["']([^"']+)["']/i.exec(tag);
    return { href: href ? decodeEntities(href[1]).trim() : '', rel: rel ? rel[1].toLowerCase() : '' };
  }).filter((link) => link.href);
  const preferred = links.find((link) => !link.rel || link.rel === 'alternate');
  return (preferred || links[0] || {}).href || '';
}

function safeHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (text.length > 1000 || !/^https?:\/\/\S+$/i.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.username || url.password) return '';
    return url.toString();
  } catch { return ''; }
}

/** 线性切块：惰性正则会在每个未闭合 <item 起点扫到串尾，畸形 feed 可退化成 O(n²) 卡死事件循环。 */
function extractBlocks(source, tagName) {
  const lower = source.toLowerCase();
  const open = `<${tagName}`;
  const close = `</${tagName}>`;
  const blocks = [];
  let pos = 0;
  while (blocks.length < 500) {
    const start = lower.indexOf(open, pos);
    if (start < 0) break;
    const boundary = lower[start + open.length] || '';
    if (boundary && !/[\s>]/.test(boundary)) {
      pos = start + open.length;
      continue;
    }
    const gt = lower.indexOf('>', start);
    if (gt < 0) break;
    const end = lower.indexOf(close, gt);
    if (end < 0) break;
    blocks.push(source.slice(start, end + close.length));
    pos = end + close.length;
  }
  return blocks;
}

export function parseRssFeed(xml, { feedUrl = '' } = {}) {
  const source = String(xml || '');
  let blocks = extractBlocks(source, 'item');
  if (!blocks.length) blocks = extractBlocks(source, 'entry');
  const channelTitle = tag(source.slice(0, source.search(/<item\b|<entry\b/i) >>> 0), 'title');
  let host = '';
  try { host = new URL(feedUrl).host.toLowerCase(); } catch { /* 保留空 */ }
  return blocks.map((block) => {
    const title = tag(block, 'title');
    const url = safeHttpUrl(tag(block, 'link') || atomLink(block));
    if (!title || !url) return null;
    const desc = tag(block, 'description') || tag(block, 'summary') || tag(block, 'content');
    const published = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated');
    const pubMs = Date.parse(published) || 0;
    const tags = [...block.matchAll(/<category\b[^>]*(?:term=["']([^"']+)["']|>([\s\S]*?)<\/category>)/gi)]
      .map((m) => stripTags(m[1] || m[2] || '').slice(0, 30))
      .filter(Boolean)
      .slice(0, 6);
    return {
      id: `rss-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 20)}`,
      title: title.slice(0, 200),
      desc: desc.slice(0, 300),
      up: (channelTitle || host).slice(0, 60),
      upMid: '',
      duration: 0,
      play: 0,
      pubdate: pubMs ? Math.floor(pubMs / 1000) : 0,
      tags,
      cover: '',
      url,
      source: 'rss',
      via: host || 'rss'
    };
  }).filter(Boolean);
}

export async function forageRss(options = {}) {
  // 显式取值而不是解构参数：ops scan 的未定义调用扫描不认识解构默认值，会把 log() 误报。
  const urls = Array.isArray(options.urls) ? options.urls : [];
  const limit = Number(options.limit) || 10;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : safeFetch;
  const log = typeof options.log === 'function' ? options.log : (() => {});
  const feeds = [...new Set((Array.isArray(urls) ? urls : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https?:\/\//i.test(url)))].slice(0, 10);
  if (!feeds.length) return [];
  const perFeed = Math.max(1, Math.ceil(Math.max(1, limit) / feeds.length));
  // 并行抓取：单 feed 30 秒总截止，10 个源最多一起等 30 秒，而不是串行 300 秒。
  const settled = await Promise.allSettled(feeds.map(async (feedUrl) => {
    const response = await fetchImpl(feedUrl, {
      maxBytes: MAX_FEED_BYTES,
      // 整次抓取总截止：safeFetch 默认只有空闲超时，慢速滴流源会把觅食卡到永远。
      signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
    if (response?.statusCode !== 200) throw new Error(`HTTP ${response?.statusCode || '?'}`);
    return parseRssFeed(response.body || '', { feedUrl }).slice(0, perFeed);
  }));
  const all = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') all.push(...result.value);
    else log(`[life-feed] RSS 读取失败：${result.reason?.message ?? result.reason}`);
  }
  return all.slice(0, Math.max(1, limit));
}
